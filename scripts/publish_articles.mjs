#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const researchMode = getArgValue("--research") || process.env.RESEARCH_MODE || "browser";
const customTopic = getArgValue("--topic").trim();
let wordpressAccessVerified = false;
let cachedCategoryIds = null;

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

async function main() {
  await loadLocalEnv(path.join(root, ".env"));

  const topics = await readTopics();
  const processed = await readProcessed();
  const pending = customTopic
    ? [customTopic]
    : topics.filter((topic) => !processed[topic]);
  const limit = Number(process.env.ARTICLE_LIMIT || 0);
  const selected = limit > 0 ? pending.slice(0, limit) : pending;

  if (!selected.length) {
    console.log("No pending topics. Add topics to wordpress-auto-publisher/topics.txt or clear state/processed.json.");
    return;
  }

  await mkdir(path.join(root, "output"), { recursive: true });
  await mkdir(path.join(root, "state"), { recursive: true });

  for (const topic of selected) {
    console.log(`Researching: ${topic}`);
    const research = await searchWeb(topic, researchMode);
    const images = await searchImages(topic, research);
    const article = await generateArticle(topic, research);
    const safeSlug = slugify(article.slug || article.title || topic);

    let uploadedImages = [];
    let wordpressPost = null;

    if (!dryRun && getBooleanEnv("AUTO_UPLOAD_IMAGES", true)) {
      uploadedImages = await uploadImages(images, safeSlug);
    }

    const html = buildPostHtml(article, research, uploadedImages);

    if (!dryRun) {
      wordpressPost = await createWordPressPost({
        title: article.title,
        content: html,
        excerpt: article.metaDescription,
        slug: safeSlug,
        featuredMedia: uploadedImages[0]?.id
      });
      console.log(`WordPress post created: ${wordpressPost.link || wordpressPost.id}`);
    } else {
      console.log("Dry run enabled: skipped image upload and WordPress post creation.");
    }

    const output = {
      topic,
      createdAt: new Date().toISOString(),
      dryRun,
      research,
      images,
      uploadedImages,
      article,
      wordpressPost
    };

    await writeFile(
      path.join(root, "output", `${safeSlug}.json`),
      JSON.stringify(output, null, 2)
    );
    await writeFile(path.join(root, "output", `${safeSlug}.html`), html);

    if (!customTopic) {
      processed[topic] = {
        createdAt: new Date().toISOString(),
        slug: safeSlug,
        wordpressId: wordpressPost?.id || null,
        wordpressLink: wordpressPost?.link || null,
        dryRun
      };
      await writeFile(path.join(root, "state", "processed.json"), JSON.stringify(processed, null, 2));
    }
  }
}

async function loadLocalEnv(envPath) {
  try {
    const envText = await readFile(envPath, "utf8");
    for (const line of envText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [key, ...valueParts] = trimmed.split("=");
      if (!process.env[key]) {
        const rawValue = valueParts.join("=").trim();
        const normalized = rawValue.startsWith('"') || rawValue.startsWith("'")
          ? rawValue.replace(/^["']|["']$/g, "")
          : rawValue.replace(/\s+#.*$/, "").trim();
        process.env[key] = normalized;
      }
    }
  } catch {
    // .env is optional if shell environment variables are already set.
  }
}

async function readTopics() {
  const text = await readFile(path.join(root, "topics.txt"), "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

async function readProcessed() {
  try {
    return JSON.parse(await readFile(path.join(root, "state", "processed.json"), "utf8"));
  } catch {
    return {};
  }
}

async function searchWeb(topic, mode) {
  if (mode === "browser") {
    return searchWebWithBrowser(topic);
  }

  const days = process.env.SEARCH_DAYS || "30";
  const query = `${topic} latest news OR updates`;
  const results = await googleSearch(query, {
    num: Number(process.env.SEARCH_RESULTS_PER_TOPIC || 8),
    dateRestrict: `d${days}`
  });

  return results.map((item) => ({
    title: item.title,
    link: item.link,
    snippet: item.snippet,
    source: item.displayLink,
    publishedHint: item.pagemap?.metatags?.[0]?.["article:published_time"] || null
  }));
}

async function searchImages(topic, research = []) {
  if (researchMode === "browser") {
    return searchImagesFromResearch(topic, research);
  }

  const results = await googleSearch(topic, {
    num: Number(process.env.IMAGE_RESULTS_PER_TOPIC || 3),
    searchType: "image",
    imgSize: "large",
    safe: "active"
  });

  return results.map((item) => ({
    title: item.title,
    link: item.link,
    contextLink: item.image?.contextLink || item.link,
    mime: item.mime || "image/jpeg",
    source: item.displayLink
  }));
}

async function googleSearch(query, extraParams = {}) {
  const key = process.env.GOOGLE_CSE_API_KEY;
  const cx = process.env.GOOGLE_CSE_ID;
  if (!key || !cx) {
    throw new Error("Missing GOOGLE_CSE_API_KEY or GOOGLE_CSE_ID in wordpress-auto-publisher/.env.");
  }

  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", key);
  url.searchParams.set("cx", cx);
  url.searchParams.set("q", query);

  for (const [keyName, value] of Object.entries(extraParams)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(keyName, String(value));
    }
  }

  const response = await fetch(url);
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`Google search failed: ${JSON.stringify(json, null, 2)}`);
  }
  return json.items || [];
}

async function searchWebWithBrowser(topic) {
  const { chromium } = await getPlaywright();
  const engines = (process.env.SEARCH_ENGINES || "google,bing,duckduckgo")
    .split(",")
    .map((engine) => engine.trim().toLowerCase())
    .filter(Boolean);
  const targetCount = Number(process.env.SEARCH_RESULTS_PER_TOPIC || 8);
  const query = `${topic} latest news updates`;
  const browser = await chromium.launch({
    headless: process.env.BROWSER_HEADLESS !== "false"
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
  });

  try {
    const seen = new Set();
    const candidates = [];
    const candidateCap = Number(process.env.BROWSER_MAX_CANDIDATES || targetCount * 2);

    for (const engine of engines) {
      console.log(`Trying search engine: ${engine}`);
      const page = await context.newPage();
      try {
        const links = await searchEngineLinks(page, engine, query);
        console.log(`${engine} returned ${links.length} candidate links`);
        for (const link of links) {
          if (seen.has(link.link)) continue;
          seen.add(link.link);
          candidates.push(link);
          if (candidates.length >= candidateCap) break;
        }
      } catch (error) {
        console.warn(`${engine} search skipped: ${error.message}`);
      } finally {
        await page.close();
      }
      if (candidates.length >= targetCount) break;
    }

    if (!candidates.length) {
      throw new Error("Browser research found no results. Try BROWSER_HEADLESS=false or change SEARCH_ENGINES.");
    }

    const researched = [];
    for (const candidate of candidates) {
      if (researched.length >= targetCount) break;
      const page = await context.newPage();
      console.log(`Reading source ${researched.length + 1}/${targetCount}: ${candidate.link}`);
      try {
        researched.push(await extractPageSummary(page, candidate));
      } catch (error) {
        console.warn(`Source skipped: ${candidate.link} (${error.message})`);
      } finally {
        await page.close();
      }
    }

    return researched;
  } finally {
    await browser.close();
  }
}

async function getPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error(
      [
        "Playwright is required for browser research mode.",
        "Install it with:",
        "  npm install -w wordpress-auto-publisher playwright",
        "  npx playwright install chromium",
        "Or run the older API mode with --research=api."
      ].join("\n")
    );
  }
}

async function searchEngineLinks(page, engine, query) {
  const url = searchUrl(engine, query);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: Number(process.env.SEARCH_PAGE_TIMEOUT_MS || 20000) });
  await page.waitForTimeout(Number(process.env.SEARCH_WAIT_MS || 2500));

  const pageText = (await page.locator("body").innerText({ timeout: 5000 })).toLowerCase();
  if (pageText.includes("unusual traffic") || pageText.includes("captcha")) {
    throw new Error("captcha or automated traffic page detected");
  }

  const rawLinks = await page.evaluate((currentEngine) => {
    const text = (node) => node?.textContent?.replace(/\s+/g, " ").trim() || "";

    if (currentEngine === "bing") {
      return Array.from(document.querySelectorAll("li.b_algo h2 a")).map((anchor) => ({
        text: text(anchor),
        href: anchor.href,
        engine: currentEngine
      }));
    }

    if (currentEngine === "duckduckgo") {
      const selectors = [
        ...Array.from(document.querySelectorAll("a.result__a")),
        ...Array.from(document.querySelectorAll("h2 a"))
      ];
      return selectors.map((anchor) => ({
        text: text(anchor),
        href: anchor.href,
        engine: currentEngine
      }));
    }

    return Array.from(document.querySelectorAll("a")).map((anchor) => ({
      text: text(anchor),
      href: anchor.href,
      engine: currentEngine
    }));
  }, engine);

  return rawLinks
    .map((link) => ({ ...link, link: normalizeSearchHref(link.href) }))
    .filter((link) => isUsefulSearchResult(link.link, link.text))
    .slice(0, Number(process.env.SEARCH_RESULTS_PER_TOPIC || 8));
}

function searchUrl(engine, query) {
  const encoded = encodeURIComponent(query);
  if (engine === "bing") return `https://www.bing.com/search?q=${encoded}&freshness=Month`;
  if (engine === "duckduckgo") return `https://html.duckduckgo.com/html/?q=${encoded}`;
  return `https://www.google.com/search?q=${encoded}&tbm=nws`;
}

function normalizeSearchHref(href) {
  try {
    const url = new URL(href);
    if (url.hostname.includes("google.") && url.pathname === "/url") {
      return url.searchParams.get("q") || href;
    }
    if (url.hostname.includes("duckduckgo.com") && url.searchParams.get("uddg")) {
      return decodeURIComponent(url.searchParams.get("uddg"));
    }
    return href;
  } catch {
    return href;
  }
}

function isUsefulSearchResult(link, text) {
  if (!link || !text || text.length < 12) return false;
  try {
    const url = new URL(link);
    const host = url.hostname.replace(/^www\./, "");
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (
      host.includes("google.") ||
      host.includes("bing.com") ||
      host.includes("duckduckgo.com") ||
      host.includes("youtube.com") ||
      host.includes("facebook.com") ||
      host.includes("instagram.com")
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function extractPageSummary(page, candidate) {
  await page.goto(candidate.link, { waitUntil: "domcontentloaded", timeout: Number(process.env.SOURCE_PAGE_TIMEOUT_MS || 20000) });
  await page.waitForTimeout(Number(process.env.PAGE_WAIT_MS || 1500));

  return page.evaluate((input) => {
    const getMeta = (selector) => document.querySelector(selector)?.getAttribute("content") || "";
    const paragraphs = Array.from(document.querySelectorAll("p"))
      .map((node) => node.textContent?.replace(/\s+/g, " ").trim() || "")
      .filter((text) => text.length > 80)
      .slice(0, 8)
      .map((text) => text.slice(0, 500));
    const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
      .map((node) => node.textContent?.replace(/\s+/g, " ").trim() || "")
      .filter(Boolean)
      .slice(0, 10);

    return {
      title: document.title || input.text,
      link: location.href,
      snippet: getMeta('meta[name="description"]') || input.text,
      source: location.hostname.replace(/^www\./, ""),
      publishedHint:
        getMeta('meta[property="article:published_time"]') ||
        getMeta('meta[name="date"]') ||
        getMeta('meta[name="pubdate"]') ||
        null,
      headings,
      keyPoints: paragraphs,
      image: getMeta('meta[property="og:image"]') || getMeta('meta[name="twitter:image"]') || null
    };
  }, candidate);
}

async function searchImagesFromResearch(topic, research) {
  const localImages = await localImagesForTopic(topic);
  const researchImages = research
    .filter((item) => item.image)
    .map((item) => ({
      title: item.title || topic,
      link: item.image,
      contextLink: item.link,
      mime: "image/jpeg",
      source: item.source
    }));

  return [...localImages, ...researchImages].slice(0, Number(process.env.IMAGE_RESULTS_PER_TOPIC || 3));
}

async function localImagesForTopic(topic) {
  const imagesDir = path.join(root, "images");
  try {
    const files = await readdir(imagesDir);
    const words = topic.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
    return files
      .filter((file) => /\.(png|jpe?g|webp|gif)$/i.test(file))
      .map((file) => ({
        file,
        score: words.filter((word) => file.toLowerCase().includes(word)).length
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Number(process.env.IMAGE_RESULTS_PER_TOPIC || 3))
      .map(({ file }) => ({
        title: file.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "),
        link: path.join(imagesDir, file),
        contextLink: "",
        mime: mimeFromFilename(file),
        source: "local"
      }));
  } catch {
    return [];
  }
}

async function generateArticle(topic, research) {
  const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  const instructions = "Return only valid JSON matching the requested schema.";
  const prompt = await renderPromptTemplate("article-writer.md", {
    TOPIC: topic,
    RESEARCH_RESULTS: JSON.stringify(research, null, 2),
    ARTICLE_SCHEMA: JSON.stringify(
      {
        title: "SEO title under 65 characters",
        slug: "url-slug",
        metaDescription: "150-160 character meta description",
        focusKeyword: "main keyword",
        secondaryKeywords: ["keyword 1", "keyword 2", "keyword 3"],
        articleHtml: "<p>Full article HTML with h2/h3 sections, bullet lists, source links, and FAQs.</p>",
        imagePrompts: ["image idea 1", "image idea 2", "image idea 3"]
      },
      null,
      2
    )
  });

  const raw = provider === "openai"
    ? await callOpenAI({ instructions, prompt })
    : await callGemini({ instructions, prompt });

  return parseJsonObject(raw);
}

async function callGemini({ instructions, prompt }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY in wordpress-auto-publisher/.env.");

  const models = getModelPool(
    process.env.GEMINI_MODEL,
    process.env.GEMINI_MODEL_POOL,
    "gemini-2.5-flash,gemma-3-1b-it,gemma-3-4b-it,gemma-3-12b-it,gemma-3-27b-it,gemma-4-26b-a4b-it,gemma-4-31b-it"
  );
  const errors = [];

  for (const model of models) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: instructions }] },
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.55,
            response_mime_type: "application/json"
          }
        })
      }
    );
    const json = await response.json();
    if (response.ok) {
      console.log(`AI model selected: ${model}`);
      return extractGeminiText(json);
    }

    errors.push(`${model}: ${json.error?.message || response.statusText}`);
    if ([401, 403].includes(response.status)) break;
  }

  throw new Error(`Gemini failed after trying ${models.length} model(s):\n${errors.join("\n")}`);
}

async function callOpenAI({ instructions, prompt }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY in wordpress-auto-publisher/.env.");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      instructions,
      input: prompt,
      temperature: 0.55,
      text: {
        format: {
          type: "json_object"
        }
      }
    })
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(`OpenAI failed: ${JSON.stringify(json, null, 2)}`);
  }
  return json.output_text || extractOpenAIText(json);
}

function extractGeminiText(json) {
  return (json.candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => part.text || "")
    .join("\n")
    .trim();
}

function extractOpenAIText(json) {
  return (json.output || [])
    .flatMap((item) => item.content || [])
    .map((content) => content.text || "")
    .join("\n")
    .trim();
}

function parseJsonObject(raw) {
  const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error(`AI did not return valid JSON:\n${raw}`);
  }
}

async function uploadImages(images, slug) {
  const uploads = [];
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    try {
      const local = image.source === "local";
      const response = local ? null : await fetch(image.link);
      if (response && !response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const buffer = local
        ? await readFile(image.link)
        : Buffer.from(await response.arrayBuffer());
      const contentType = local ? image.mime : response.headers.get("content-type") || image.mime || "image/jpeg";
      const extension = mimeToExtension(contentType);
      const filename = `${slug}-${index + 1}.${extension}`;
      const uploaded = await uploadWordPressMedia({
        filename,
        contentType,
        buffer,
        altText: image.title
      });
      uploads.push({
        ...uploaded,
        sourceUrl: image.contextLink,
        originalImageUrl: image.link
      });
    } catch (error) {
      console.warn(`Image skipped: ${image.link} (${error.message})`);
    }
  }
  return uploads;
}

async function uploadWordPressMedia({ filename, contentType, buffer, altText }) {
  const url = `${wordpressBaseUrl()}/wp-json/wp/v2/media`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: wordpressAuthHeader(),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": contentType
    },
    body: buffer
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`WordPress media upload failed: ${JSON.stringify(json, null, 2)}`);
  }

  if (altText) {
    await fetch(`${url}/${json.id}`, {
      method: "POST",
      headers: {
        Authorization: wordpressAuthHeader(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ alt_text: altText })
    });
  }

  return {
    id: json.id,
    url: json.source_url,
    alt: altText
  };
}

async function createWordPressPost({ title, content, excerpt, slug, featuredMedia }) {
  requireWordPressConfig();
  await verifyWordPressAccess();
  const body = {
    title,
    content,
    excerpt,
    slug,
    status: getValidWordPressStatus()
  };

  if (featuredMedia) body.featured_media = featuredMedia;
  const categoryIds = await resolveDefaultCategoryIds();
  if (categoryIds.length) body.categories = categoryIds;
  addIdList(body, "tags", process.env.WP_DEFAULT_TAG_IDS);

  const response = await fetch(`${wordpressBaseUrl()}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: {
      Authorization: wordpressAuthHeader(),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`WordPress post creation failed: ${JSON.stringify(json, null, 2)}`);
  }
  return json;
}

function buildPostHtml(article, research, images) {
  const secondaryImages = images.slice(1, 3);
  const articleWithImages = injectImagesIntoArticle(article.articleHtml, secondaryImages, article);

  const sources = research
    .map((item) => `<li><a href="${escapeHtml(item.link)}">${escapeHtml(item.title)}</a> - ${escapeHtml(item.source || "")}</li>`)
    .join("\n");

  return [
    articleWithImages,
    "<h2>Sources</h2>",
    `<ul>${sources}</ul>`
  ].filter(Boolean).join("\n\n");
}

function injectImagesIntoArticle(articleHtml, images, article) {
  if (!images.length) return articleHtml;

  const parts = articleHtml.split(/(<h2[^>]*>.*?<\/h2>)/i).filter(Boolean);
  let imageIndex = 0;
  const output = [];

  for (let index = 0; index < parts.length; index += 1) {
    output.push(parts[index]);

    const isHeading = /^<h2/i.test(parts[index]);
    if (isHeading && imageIndex < images.length && shouldInsertImageAfterHeading(parts[index])) {
      output.push(renderInlineImage(images[imageIndex], article, "section"));
      imageIndex += 1;
    }
  }

  while (imageIndex < images.length) {
    output.push(renderInlineImage(images[imageIndex], article, "section"));
    imageIndex += 1;
  }

  return output.join("\n\n");
}

function shouldInsertImageAfterHeading(headingHtml) {
  const text = headingHtml
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!text) return false;
  if (text.includes("table of contents")) return false;
  if (text === "sources") return false;
  return true;
}

function renderInlineImage(image, article, variant = "section") {
  const alt = escapeHtml(image.alt || article.focusKeyword || article.title);
  const url = escapeHtml(image.url);
  const sourceLink = image.sourceUrl
    ? `<figcaption style="margin-top:8px;font-size:12px;color:#666;">Image source: <a href="${escapeHtml(image.sourceUrl)}" target="_blank" rel="noopener noreferrer">source</a></figcaption>`
    : "";

  const figureStyle =
    variant === "hero"
      ? "margin:24px 0 32px 0;"
      : "margin:28px 0;";

  const imageStyle =
    "display:block;width:100%;max-width:100%;height:auto;border-radius:10px;";

  return [
    `<figure style="${figureStyle}">`,
    `<img src="${url}" alt="${alt}" style="${imageStyle}" />`,
    sourceLink,
    `</figure>`
  ].filter(Boolean).join("\n");
}

function wordpressBaseUrl() {
  return (process.env.WP_BASE_URL || "").replace(/\/$/, "");
}

function wordpressAuthHeader() {
  requireWordPressConfig();
  const token = Buffer.from(`${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`).toString("base64");
  return `Basic ${token}`;
}

function requireWordPressConfig() {
  if (!process.env.WP_BASE_URL || !process.env.WP_USERNAME || !process.env.WP_APP_PASSWORD) {
    throw new Error("Missing WP_BASE_URL, WP_USERNAME, or WP_APP_PASSWORD in wordpress-auto-publisher/.env.");
  }
}

async function verifyWordPressAccess() {
  if (wordpressAccessVerified) return;
  const response = await fetch(`${wordpressBaseUrl()}/wp-json/wp/v2/users/me?context=edit`, {
    headers: {
      Authorization: wordpressAuthHeader()
    }
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(
      [
        "WordPress authentication failed.",
        `Response: ${JSON.stringify(json, null, 2)}`,
        "Check WP_BASE_URL, WP_USERNAME, WP_APP_PASSWORD, and the user's role.",
        "The WordPress user should usually be Author, Editor, or Administrator."
      ].join("\n")
    );
  }
  wordpressAccessVerified = true;
}

function addIdList(body, key, value) {
  if (!value) return;
  const ids = value.split(",").map((id) => Number(id.trim())).filter(Boolean);
  if (ids.length) body[key] = ids;
}

async function resolveDefaultCategoryIds() {
  if (cachedCategoryIds) return cachedCategoryIds;

  const explicitIds = (process.env.WP_DEFAULT_CATEGORY_IDS || "")
    .split(",")
    .map((id) => Number(id.trim()))
    .filter(Boolean);
  if (explicitIds.length) {
    cachedCategoryIds = explicitIds;
    return cachedCategoryIds;
  }

  const categoryName = (process.env.WP_DEFAULT_CATEGORY_NAME || "").trim();
  if (!categoryName) {
    cachedCategoryIds = [];
    return cachedCategoryIds;
  }

  const response = await fetch(
    `${wordpressBaseUrl()}/wp-json/wp/v2/categories?search=${encodeURIComponent(categoryName)}&per_page=100`,
    {
      headers: {
        Authorization: wordpressAuthHeader()
      }
    }
  );
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`Could not load WordPress categories: ${JSON.stringify(json, null, 2)}`);
  }

  const normalized = categoryName.toLowerCase();
  const exactMatch = json.find((item) => (item.name || "").trim().toLowerCase() === normalized);
  if (!exactMatch) {
    throw new Error(
      `Could not find WordPress category named "${categoryName}". Add WP_DEFAULT_CATEGORY_IDS instead, or verify the category name.`
    );
  }

  cachedCategoryIds = [exactMatch.id];
  return cachedCategoryIds;
}

function getModelPool(fixedModel, configuredPool, fallbackPool) {
  if (fixedModel?.trim()) return [fixedModel.trim()];
  return shuffle(
    (configuredPool || fallbackPool)
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean)
      .filter((model) => !model.toLowerCase().includes("tts"))
  );
}

function shuffle(values) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "article";
}

function mimeToExtension(mime) {
  if (mime?.includes("png")) return "png";
  if (mime?.includes("webp")) return "webp";
  if (mime?.includes("gif")) return "gif";
  return "jpg";
}

function mimeFromFilename(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

function getArgValue(name) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : "";
}

function getBooleanEnv(key, fallback) {
  const value = process.env[key];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function getValidWordPressStatus() {
  const allowed = new Set(["publish", "future", "draft", "pending", "private"]);
  const status = (process.env.WP_POST_STATUS || "draft").trim().toLowerCase();
  if (!allowed.has(status)) {
    throw new Error(
      `Invalid WP_POST_STATUS="${process.env.WP_POST_STATUS}". Use one of: publish, future, draft, pending, private.`
    );
  }
  return status;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function renderPromptTemplate(filename, variables) {
  const filePath = path.join(root, "prompts", filename);
  let template = await readFile(filePath, "utf8");

  for (const [key, value] of Object.entries(variables)) {
    template = template.replaceAll(`{{${key}}}`, value);
  }

  return template;
}

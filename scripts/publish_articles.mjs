#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const selectedSite = getArgValue("--site").trim() || process.env.SITE || "";

const originalFetch = typeof globalThis.fetch === "function" ? globalThis.fetch : null;
const fetch = originalFetch ? fetchWithDnsFallback : dnsFetch;

function isDnsResolutionFailure(error) {
  const message = String(error?.message || "");
  const causeCode = error?.cause?.code;
  return (
    /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message) ||
    causeCode === "ENOTFOUND" ||
    causeCode === "EAI_AGAIN"
  );
}

async function fetchWithDnsFallback(url, options = {}) {
  try {
    return await originalFetch(url, options);
  } catch (error) {
    if (isDnsResolutionFailure(error) && typeof url === "string") {
      console.warn(
        `fetch failed for ${url}. Falling back to custom DNS fetch because of DNS resolution error.`,
      );
      return dnsFetch(url, options);
    }
    throw error;
  }
}

async function resolveHost(hostname) {
  const addresses = [];
  try {
    const v4 = await dns.promises.resolve4(hostname);
    addresses.push(...v4.map((address) => ({ address, family: 4 })));
  } catch {
    // ignore v4 resolution failures and try v6.
  }
  try {
    const v6 = await dns.promises.resolve6(hostname);
    addresses.push(...v6.map((address) => ({ address, family: 6 })));
  } catch {
    // ignore v6 resolution failures.
  }
  if (!addresses.length) {
    throw new Error(`DNS lookup failed for hostname: ${hostname}`);
  }
  return addresses;
}

async function dnsFetch(input, options = {}) {
  const url = new URL(input);
  const addresses = await resolveHost(url.hostname);
  if (!addresses?.length) {
    throw new Error(`DNS lookup failed for hostname: ${url.hostname}`);
  }

  const address =
    addresses.find((entry) => entry.family === 4) || addresses[0];
  const isHttps = url.protocol === "https:";
  const requestOptions = {
    protocol: url.protocol,
    hostname: address.address,
    port:
      url.port || (isHttps ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    method: options.method || "GET",
    headers: options.headers || {},
    servername: url.hostname,
    timeout: options.timeout || 0,
  };

  return new Promise((resolve, reject) => {
    const req = (isHttps ? https.request : http.request)(
      requestOptions,
      (res) => {
        const response = new Response(res, {
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: res.headers,
        });
        resolve(response);
      },
    );

    req.on("error", reject);
    if (options.signal) {
      if (options.signal.aborted) {
        req.destroy(new Error("The operation was aborted."));
      } else {
        options.signal.addEventListener("abort", () => {
          req.destroy(new Error("The operation was aborted."));
        });
      }
    }

    if (options.body != null) {
      const body = options.body;
      if (typeof body === "string" || body instanceof Buffer) {
        req.write(body);
      } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        req.write(Buffer.from(body));
      } else if (typeof body.pipe === "function") {
        body.pipe(req);
        return;
      } else if (typeof body === "object") {
        req.write(JSON.stringify(body));
      } else {
        req.write(String(body));
      }
    }

    req.end();
  });
}
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
  const envPath = await resolveEnvPath();
  await loadLocalEnv(envPath);
  const researchMode =
    getArgValue("--research") || process.env.RESEARCH_MODE || "browser";
  const topicsPath = resolveTopicsPath();
  const processedPath = resolveProcessedPath();

  console.log(`Using env: ${path.basename(envPath)}`);
  if (selectedSite) {
    console.log(`Using site profile: ${selectedSite}`);
  }
  console.log(`Using topics: ${path.basename(topicsPath)}`);
  console.log(`Using state: ${path.relative(root, processedPath)}`);

  const siteContext = await readSiteContext();
  const internalLinks = await readInternalLinks();
  const topics = await readTopics(topicsPath);
  const processed = await readProcessed(processedPath);
  const useRandom = getBooleanEnv("RANDOM_TOPIC", false);
  const pendingTopics = topics.filter((topic) => !processed[topic]);
  let runnableTopics = customTopic ? [customTopic] : pendingTopics;

  if (!runnableTopics.length) {
    runnableTopics = topics;
  }

  const limit = Number(process.env.ARTICLE_LIMIT || (useRandom ? 1 : 0));

  if (!runnableTopics.length) {
    console.log(`No pending topics found. All topics already processed.`);
    return;
  }

  const selected = limit > 0 ? getRandomItems(runnableTopics, limit) : runnableTopics;

  if (!selected.length) {
    console.log(`No topics found. Add topics to ${path.basename(topicsPath)}.`);
    return;
  }

  await mkdir(path.join(root, "state"), { recursive: true });
  await writeFile(processedPath, JSON.stringify(processed, null, 2)).catch(
    () => {},
  );

  for (const topic of selected) {
    console.log(`Researching: ${topic}`);
    const research = await searchWeb(topic, researchMode);
    const images = await searchImages(topic, research, researchMode);
    const article = await generateArticle(topic, research, {
      siteContext,
      internalLinks,
    });
    const safeSlug = slugify(article.slug || article.title || topic);

    let uploadedImages = [];
    let wordpressPost = null;

    if (!dryRun && getBooleanEnv("AUTO_UPLOAD_IMAGES", true)) {
      uploadedImages = await uploadImages(images, safeSlug, topic, article.focusKeyword);
      await markUsedImages(uploadedImages);
    }

    const html = buildPostHtml(
      article,
      research,
      uploadedImages,
      safeSlug,
      internalLinks,
    );
    runSeoQualityGate({
      article,
      html,
      research,
      images: uploadedImages,
      internalLinks,
      slug: safeSlug,
    });

    if (!dryRun) {
      wordpressPost = await createWordPressPost({
        title: article.title,
        content: html,
        excerpt: article.metaDescription,
        slug: safeSlug,
        featuredMedia: uploadedImages[0]?.id,
        focusKeyword: article.focusKeyword,
      });
      console.log(
        `WordPress post created: ${wordpressPost.link || wordpressPost.id}`,
      );
      await updateLlmsTxt({
        title: article.title,
        topic,
        url: wordpressPost.link || null,
      });
      await writeSocialContentOutput({
        article,
        topic,
        url: wordpressPost.link || null,
        slug: safeSlug,
      });
    } else {
      console.log(
        "Dry run enabled: skipped image upload and WordPress post creation.",
      );
    }

    processed[topic] = {
      createdAt: new Date().toISOString(),
      slug: safeSlug,
      wordpressId: wordpressPost?.id || null,
      wordpressLink: wordpressPost?.link || null,
      dryRun,
    };
    await writeFile(processedPath, JSON.stringify(processed, null, 2));
  }
}

async function loadLocalEnv(envPath) {
  try {
    const envText = await readFile(envPath, "utf8");
    for (const line of envText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("="))
        continue;
      const [key, ...valueParts] = trimmed.split("=");
      if (!process.env[key]) {
        const rawValue = valueParts.join("=").trim();
        const normalized =
          rawValue.startsWith('"') || rawValue.startsWith("'")
            ? rawValue.replace(/^["']|["']$/g, "")
            : rawValue.replace(/\s+#.*$/, "").trim();
        const value = normalized.startsWith(`${key}=`)
          ? normalized.slice(key.length + 1)
          : normalized;
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional if shell environment variables are already set.
  }
}

async function resolveEnvPath() {
  const explicitEnvFile = process.env.ENV_FILE || getArgValue("--env");
  const siteEnvCandidate = selectedSite
    ? path.join(root, `${selectedSite}.env`)
    : "";
  const candidates = [
    explicitEnvFile ? path.resolve(root, explicitEnvFile) : "",
    siteEnvCandidate,
    path.join(root, ".env"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  throw new Error(
    selectedSite
      ? `Could not find an env file for site "${selectedSite}". Expected ${selectedSite}.env or use --env=filename.`
      : "Could not find an env file. Add .env or pass --env=filename.",
  );
}

function resolveTopicsPath() {
  const explicitTopics = (
    process.env.TOPICS_FILE || getArgValue("--topics")
  ).trim();
  if (explicitTopics) return path.resolve(root, explicitTopics);
  if (selectedSite) {
    return path.join(root, `topics.${selectedSite}.txt`);
  }
  return path.join(root, "topics.txt");
}

function resolveProcessedPath() {
  const explicitState = (
    process.env.STATE_FILE || getArgValue("--state")
  ).trim();
  if (explicitState) return path.resolve(root, explicitState);
  if (selectedSite) {
    return path.join(root, "state", `processed.${selectedSite}.json`);
  }
  return path.join(root, "state", "processed.json");
}

function resolveLlmsPath() {
  const explicitLlms = (process.env.LLMS_FILE || getArgValue("--llms")).trim();
  if (explicitLlms) return path.resolve(root, explicitLlms);
  if (selectedSite) {
    return path.join(root, `llms.${selectedSite}.txt`);
  }
  return path.join(root, "llms.txt");
}

async function readTopics(topicsPath) {
  const text = await readFileWithFallback(
    topicsPath,
    selectedSite ? path.join(root, "topics.txt") : "",
  );
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

async function readProcessed(processedPath) {
  try {
    return JSON.parse(await readFile(processedPath, "utf8"));
  } catch {
    if (selectedSite) return {};
    return {};
  }
}

async function readSiteContext() {
  const contextPath = path.join(root, ".agents", "product-marketing-context.md");
  try {
    const fullContext = await readFile(contextPath, "utf8");
    const section = extractMarkdownSection(fullContext, selectedSite);
    return section || fullContext;
  } catch {
    return "";
  }
}

async function readInternalLinks() {
  const explicitLinks = (
    process.env.INTERNAL_LINKS_FILE || getArgValue("--internal-links")
  ).trim();
  const candidates = [
    explicitLinks ? path.resolve(root, explicitLinks) : "",
    selectedSite ? path.join(root, "data", `internal-links.${selectedSite}.json`) : "",
    path.join(root, "data", "internal-links.json"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const links = JSON.parse(await readFile(candidate, "utf8"));
      return Array.isArray(links) ? normalizeInternalLinks(links) : [];
    } catch {
      // Try the next links file.
    }
  }

  return [];
}

function normalizeInternalLinks(links) {
  return links
    .map((link) => ({
      keyword: String(link.keyword || link.anchor || "").trim(),
      anchor: String(link.anchor || link.keyword || "").trim(),
      url: String(link.url || "").trim(),
    }))
    .filter((link) => link.anchor && /^https?:\/\//i.test(link.url));
}

function extractMarkdownSection(markdown, sectionName) {
  const normalizedSection = String(sectionName || "").trim().toLowerCase();
  if (!normalizedSection) return "";

  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const match = line.match(/^##\s+(.+?)\s*$/);
    return match && match[1].trim().toLowerCase() === normalizedSection;
  });
  if (start === -1) return "";

  let end = start + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end])) {
    end += 1;
  }

  return lines.slice(start, end).join("\n").trim();
}

async function readFileWithFallback(primaryPath, fallbackPath) {
  try {
    return await readFile(primaryPath, "utf8");
  } catch (error) {
    if (!fallbackPath) throw error;
    return readFile(fallbackPath, "utf8");
  }
}

async function searchWeb(topic, mode) {
  if (mode !== "browser") {
    console.log(
      "Google Custom Search API mode is temporarily disabled. Using browser research instead.",
    );
  }

  // Google Custom Search API path intentionally disabled for now.
  // Keep the helper below in place so it can be restored later if needed.
  return searchWebWithBrowser(topic);
}

async function searchImages(topic, research = [], mode = "browser") {
  if (mode !== "browser") {
    console.log(
      "Google Custom Search API image mode is temporarily disabled. Using images from researched pages instead.",
    );
  }

  // Google Custom Search API image path intentionally disabled for now.
  return searchImagesFromResearch(topic, research);
}

function shouldFallbackToBrowser(error, mode) {
  if (mode !== "api") return false;
  const message = String(error?.message || "");
  return (
    message.includes("Google search failed:") ||
    message.includes("Missing GOOGLE_CSE_API_KEY") ||
    message.includes("Missing GOOGLE_CSE_ID")
  );
}

async function googleSearch(query, extraParams = {}) {
  const key = process.env.GOOGLE_CSE_API_KEY;
  const cx = process.env.GOOGLE_CSE_ID;
  if (!key || !cx) {
    throw new Error(
      "Missing GOOGLE_CSE_API_KEY or GOOGLE_CSE_ID in wordpress-auto-publisher/.env.",
    );
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
  const requestedHeadless = process.env.BROWSER_HEADLESS !== "false";
  const forcedHeadless = process.platform === "linux" && !process.env.DISPLAY;
  const headless = forcedHeadless ? true : requestedHeadless;

  if (forcedHeadless && !requestedHeadless) {
    console.log("No DISPLAY detected on Linux. Forcing headless browser mode.");
  }

  const browser = await chromium.launch({
    headless,
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
  });

  try {
    const seen = new Set();
    const candidates = [];
    const candidateCap = Number(
      process.env.BROWSER_MAX_CANDIDATES || targetCount * 2,
    );

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
      console.warn(
        "Browser search engines returned no results. Trying curated source fallback.",
      );
      return await researchFromCuratedSources(context, topic, targetCount);
    }

    const researched = [];
    const readLinks = new Set();
    for (const candidate of candidates) {
      if (researched.length >= targetCount) break;
      const page = await context.newPage();
      console.log(
        `Reading source ${researched.length + 1}/${targetCount}: ${candidate.link}`,
      );
      try {
        const summary = await extractPageSummary(page, candidate);
        const expanded = await expandNewsHubSummary({
          context,
          summary,
          topic,
          readLinks,
          remaining: targetCount - researched.length,
        });
        researched.push(...expanded);
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

async function researchFromCuratedSources(context, topic, targetCount) {
  const sourceUrls = getCuratedSourceUrls(topic).slice(
    0,
    Number(process.env.CURATED_SOURCE_LIMIT || 10),
  );
  const researched = [];

  for (const sourceUrl of sourceUrls) {
    if (researched.length >= targetCount) break;
    const page = await context.newPage();
    console.log(
      `Reading curated source ${researched.length + 1}/${Math.min(targetCount, sourceUrls.length)}: ${sourceUrl}`,
    );
    try {
      const summary = await extractCuratedSourceSummary(page, sourceUrl, topic);
      if (isRelevantCuratedSummary(summary, topic)) {
        researched.push(summary);
      } else {
        console.warn(
          `Curated source skipped: ${sourceUrl} (not relevant enough for topic)`,
        );
      }
    } catch (error) {
      console.warn(`Curated source skipped: ${sourceUrl} (${error.message})`);
    } finally {
      await page.close();
    }
  }

  if (!researched.length) {
    throw new Error(
      "Browser research found no results, and curated fallback sources were not usable.",
    );
  }

  return researched;
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
        "Or run the older API mode with --research=api.",
      ].join("\n"),
    );
  }
}

async function searchEngineLinks(page, engine, query) {
  const url = searchUrl(engine, query);
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: Number(process.env.SEARCH_PAGE_TIMEOUT_MS || 20000),
  });
  await page.waitForTimeout(Number(process.env.SEARCH_WAIT_MS || 2500));

  const pageText = (
    await page.locator("body").innerText({ timeout: 5000 })
  ).toLowerCase();
  if (pageText.includes("unusual traffic") || pageText.includes("captcha")) {
    throw new Error("captcha or automated traffic page detected");
  }

  const rawLinks = await page.evaluate((currentEngine) => {
    const text = (node) => node?.textContent?.replace(/\s+/g, " ").trim() || "";

    if (currentEngine === "bing") {
      return Array.from(document.querySelectorAll("li.b_algo h2 a")).map(
        (anchor) => ({
          text: text(anchor),
          href: anchor.href,
          engine: currentEngine,
        }),
      );
    }

    if (currentEngine === "duckduckgo") {
      const selectors = [
        ...Array.from(document.querySelectorAll("a.result__a")),
        ...Array.from(document.querySelectorAll("h2 a")),
      ];
      return selectors.map((anchor) => ({
        text: text(anchor),
        href: anchor.href,
        engine: currentEngine,
      }));
    }

    return Array.from(document.querySelectorAll("a")).map((anchor) => ({
      text: text(anchor),
      href: anchor.href,
      engine: currentEngine,
    }));
  }, engine);

  return rawLinks
    .map((link) => ({ ...link, link: normalizeSearchHref(link.href) }))
    .filter((link) => isUsefulSearchResult(link.link, link.text))
    .slice(0, Number(process.env.SEARCH_RESULTS_PER_TOPIC || 8));
}

function searchUrl(engine, query) {
  const encoded = encodeURIComponent(query);
  if (engine === "bing")
    return `https://www.bing.com/search?q=${encoded}&freshness=Month`;
  if (engine === "duckduckgo")
    return `https://html.duckduckgo.com/html/?q=${encoded}`;
  return `https://www.google.com/search?q=${encoded}&tbm=nws`;
}

function normalizeSearchHref(href) {
  try {
    const url = new URL(href);
    if (url.hostname.includes("google.") && url.pathname === "/url") {
      return url.searchParams.get("q") || href;
    }
    if (
      url.hostname.includes("duckduckgo.com") &&
      url.searchParams.get("uddg")
    ) {
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
    const path = url.pathname || "/";
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (url.hash && (!path || path === "/")) return false;
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
    if (
      /\/(audio|podcasts?|shows?|videos?|watch|listen)\//i.test(path) ||
      /\/#?$/.test(path) ||
      path === "/"
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function extractPageSummary(page, candidate) {
  await page.goto(candidate.link, {
    waitUntil: "domcontentloaded",
    timeout: Number(process.env.SOURCE_PAGE_TIMEOUT_MS || 20000),
  });
  await page.waitForTimeout(Number(process.env.PAGE_WAIT_MS || 1500));

  return page.evaluate((input) => {
    const getMeta = (selector) =>
      document.querySelector(selector)?.getAttribute("content") || "";
    const paragraphs = Array.from(document.querySelectorAll("p"))
      .map((node) => node.textContent?.replace(/\s+/g, " ").trim() || "")
      .filter((text) => text.length > 80)
      .slice(0, 8)
      .map((text) => text.slice(0, 500));
    const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
      .map((node) => node.textContent?.replace(/\s+/g, " ").trim() || "")
      .filter(Boolean)
      .slice(0, 10);

    const imageCandidates = [];
    const ogImage = getMeta('meta[property="og:image"]');
    const twitterImage = getMeta('meta[name="twitter:image"]');
    if (ogImage) imageCandidates.push(ogImage);
    if (twitterImage && twitterImage !== ogImage) imageCandidates.push(twitterImage);

    const imageNodes = Array.from(document.images);
    imageNodes.forEach((node) => {
      const src = node.currentSrc || node.src || "";
      if (
        src &&
        !src.startsWith("data:") &&
        /^https?:\/\//i.test(src) &&
        !imageCandidates.includes(src)
      ) {
        imageCandidates.push(src);
      }
    });

    const images = imageCandidates.map((url) => {
      const node = imageNodes.find(
        (image) => image.currentSrc === url || image.src === url,
      );
      return {
        url,
        width: node?.naturalWidth || 0,
        height: node?.naturalHeight || 0,
      };
    });

    const bestImage = images.sort(
      (a, b) => b.width * b.height - a.width * a.height,
    )[0];
    const articleLinks = Array.from(document.querySelectorAll("a"))
      .map((anchor) => ({
        text: anchor.textContent?.replace(/\s+/g, " ").trim() || "",
        href: anchor.href,
      }))
      .filter((link) => link.text.length > 18 && /^https?:\/\//i.test(link.href))
      .filter((link) => {
        try {
          const url = new URL(link.href);
          return url.hostname.replace(/^www\./, "") === location.hostname.replace(/^www\./, "");
        } catch {
          return false;
        }
      })
      .slice(0, 12);

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
      image: bestImage?.url || null,
      images,
      articleLinks,
    };
  }, candidate);
}

async function expandNewsHubSummary({
  context,
  summary,
  topic,
  readLinks,
  remaining,
}) {
  if (!shouldExpandNewsHub(summary) || remaining <= 1) {
    readLinks.add(summary.link);
    return [summary];
  }

  const expanded = [];
  const links = (summary.articleLinks || [])
    .filter((link) => isUsefulSearchResult(link.href, link.text))
    .filter((link) => !readLinks.has(link.href))
    .slice(0, Math.min(3, remaining));

  for (const link of links) {
    const page = await context.newPage();
    try {
      readLinks.add(link.href);
      console.log(`Reading article from news hub: ${link.href}`);
      const articleSummary = await extractPageSummary(page, {
        text: link.text,
        link: link.href,
      });
      if (isRelevantCuratedSummary(articleSummary, topic)) {
        expanded.push(articleSummary);
      }
    } catch (error) {
      console.warn(`Hub article skipped: ${link.href} (${error.message})`);
    } finally {
      await page.close();
    }
  }

  if (expanded.length) return expanded;
  readLinks.add(summary.link);
  return [summary];
}

function shouldExpandNewsHub(summary) {
  if (!selectedSite.toLowerCase().includes("kafirana")) return false;
  try {
    const url = new URL(summary.link);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const hubLikePath =
      pathParts.length <= 1 ||
      /^(us|news|world|politics|entertainment|latest|trending)$/i.test(
        pathParts.at(-1) || "",
      );
    return hubLikePath && (summary.articleLinks || []).length > 0;
  } catch {
    return false;
  }
}

async function extractCuratedSourceSummary(page, sourceUrl, topic) {
  await page.goto(sourceUrl, {
    waitUntil: "domcontentloaded",
    timeout: Number(process.env.SOURCE_PAGE_TIMEOUT_MS || 20000),
  });
  await page.waitForTimeout(Number(process.env.PAGE_WAIT_MS || 1500));

  return page.evaluate(
    (input) => {
      const getMeta = (selector) =>
        document.querySelector(selector)?.getAttribute("content") || "";
      const paragraphs = Array.from(document.querySelectorAll("p, li"))
        .map((node) => node.textContent?.replace(/\s+/g, " ").trim() || "")
        .filter((text) => text.length > 60)
        .slice(0, 12)
        .map((text) => text.slice(0, 500));
      const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
        .map((node) => node.textContent?.replace(/\s+/g, " ").trim() || "")
        .filter(Boolean)
        .slice(0, 16);

      const imageCandidates = [];
      const ogImage = getMeta('meta[property="og:image"]');
      const twitterImage = getMeta('meta[name="twitter:image"]');
      if (ogImage) imageCandidates.push(ogImage);
      if (twitterImage && twitterImage !== ogImage) imageCandidates.push(twitterImage);

      const imageNodes = Array.from(document.images);
      imageNodes.forEach((node) => {
        const src = node.currentSrc || node.src || "";
        if (
          src &&
          !src.startsWith("data:") &&
          /^https?:\/\//i.test(src) &&
          !imageCandidates.includes(src)
        ) {
          imageCandidates.push(src);
        }
      });

      const images = imageCandidates.map((url) => {
        const node = imageNodes.find(
          (image) => image.currentSrc === url || image.src === url,
        );
        return {
          url,
          width: node?.naturalWidth || 0,
          height: node?.naturalHeight || 0,
        };
      });

      const bestImage = images.sort(
        (a, b) => b.width * b.height - a.width * a.height,
      )[0];

      return {
        title: document.title || input.topic,
        link: location.href,
        snippet:
          getMeta('meta[name="description"]') || headings[0] || input.topic,
        source: location.hostname.replace(/^www\./, ""),
        publishedHint:
          getMeta('meta[property="article:published_time"]') ||
          getMeta('meta[name="date"]') ||
          getMeta('meta[name="pubdate"]') ||
          null,
        headings,
        keyPoints: paragraphs,
        image:
          getMeta('meta[property="og:image"]') ||
          getMeta('meta[name="twitter:image"]') ||
          bestImage?.url ||
          null,
        images,
      };
    },
    { topic },
  );
}

function getCuratedSourceUrls(topic) {
  const lower = topic.toLowerCase();
  const site = selectedSite.toLowerCase();
  const urls = new Set();

  const add = (...items) => items.forEach((item) => urls.add(item));
  const isIpoOrStockTopic =
    site.includes("elitebulletin") ||
    /(ipo|gmp|grey market|allotment|stock|share|nifty|sensex|demat|invest|equity|market|mutual fund|bse|nse|sebi|listing)/.test(
      lower,
    );
  const isBroadNewsTopic =
    /(latest news|breaking news|trending news|us news|news in the us|what('?s| is) happening|top news|current events|headlines)/.test(
      lower,
    );
  const isBroadAiTopic =
    /(new launch in ai|latest ai|ai update|ai news|new ai|new model|new tool|artificial intelligence update|llm update|ai breakthrough)/.test(
      lower,
    );

  if (isIpoOrStockTopic) {
    add(
      "https://www.chittorgarh.com/report/ipo-in-india-list-main-board-sme/82/",
      "https://ipowatch.in/ipo-grey-market-premium-latest-ipo-gmp/",
      "https://www.moneycontrol.com/ipo/",
      "https://www.livemint.com/market/ipo",
      "https://economictimes.indiatimes.com/markets/ipos/fpos",
      "https://www.nseindia.com/market-data/all-upcoming-issues-ipo",
      "https://www.bseindia.com/publicissue.html",
    );
  } else if (isBroadNewsTopic) {
    add(
      "https://apnews.com/",
      "https://apnews.com/us-news",
      "https://www.reuters.com/world/us/",
      "https://www.reuters.com/world/",
      "https://www.npr.org/sections/news/",
      "https://www.usatoday.com/news/",
      "https://www.cbsnews.com/latest/",
      "https://abcnews.go.com/US",
      "https://www.nbcnews.com/us-news",
      "https://www.politico.com/news/",
      "https://www.axios.com/",
    );
  } else if (isBroadAiTopic) {
    add(
      "https://www.reuters.com/technology/",
      "https://techcrunch.com/category/artificial-intelligence/",
      "https://www.theverge.com/ai-artificial-intelligence",
      "https://www.zdnet.com/topic/artificial-intelligence/",
      "https://openai.com/news/",
      "https://blog.google/technology/ai/",
      "https://deepmind.google/discover/blog/",
      "https://www.anthropic.com/news",
      "https://blog.google/products/gemini/",
    );
  } else {
    add(
      "https://news.google.com/",
      "https://www.reuters.com/",
      "https://apnews.com/",
    );
  }

  return Array.from(urls);
}

function isRelevantCuratedSummary(summary, topic) {
  const haystack = [
    summary.title,
    summary.snippet,
    ...(summary.headings || []),
    ...(summary.keyPoints || []),
  ]
    .join(" ")
    .toLowerCase();

  const terms = topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);

  const broadNewsTopic =
    /(latest news|breaking news|trending news|us news|news in the us|what('?s| is) happening|top news|current events|headlines)/.test(
      topic.toLowerCase(),
    );
  const broadAiTopic =
    /(new launch in ai|latest ai|ai update|ai news|new ai|new model|new tool|artificial intelligence update|llm update|ai breakthrough)/.test(
      topic.toLowerCase(),
    );
  const isIpoOrStock =
    selectedSite.toLowerCase().includes("elitebulletin") ||
    /(ipo|gmp|grey market|allotment|stock|share|nifty|sensex|demat|invest|equity|market|mutual fund|bse|nse|sebi|listing)/.test(
      topic.toLowerCase(),
    );

  const trustedNewsSource =
    /(?:^|\.)apnews\.com$|(?:^|\.)reuters\.com$|(?:^|\.)npr\.org$|(?:^|\.)usatoday\.com$|(?:^|\.)cbsnews\.com$|(?:^|\.)abcnews\.go\.com$|(?:^|\.)nbcnews\.com$|(?:^|\.)politico\.com$|(?:^|\.)axios\.com$/.test(
      String(summary.source || "").toLowerCase(),
    );
  const trustedAiSource =
    /(?:^|\.)reuters\.com$|(?:^|\.)techcrunch\.com$|(?:^|\.)theverge\.com$|(?:^|\.)zdnet\.com$|(?:^|\.)openai\.com$|(?:^|\.)blog\.google$|(?:^|\.)deepmind\.google$|(?:^|\.)anthropic\.com$|(?:^|\.)developers\.googleblog\.com$/.test(
      String(summary.source || "").toLowerCase(),
    );
  const trustedFinancialSource =
    /(?:^|\.)chittorgarh\.com$|(?:^|\.)ipowatch\.in$|(?:^|\.)moneycontrol\.com$|(?:^|\.)livemint\.com$|(?:^|\.)economictimes\.indiatimes\.com$|(?:^|\.)nseindia\.com$|(?:^|\.)bseindia\.com$/.test(
      String(summary.source || "").toLowerCase(),
    );

  if (isIpoOrStock && trustedFinancialSource) return true;
  if (broadNewsTopic && trustedNewsSource) return true;
  if (broadAiTopic && trustedAiSource) return true;
  if (!terms.length) return true;
  const matchCount = terms.filter((term) => haystack.includes(term)).length;
  return matchCount >= Math.min(2, terms.length);
}

async function searchImagesFromResearch(topic, research) {
  const localImages = await localImagesForTopic(topic);
  const usedImages = await readUsedImages();
  const researchImages = research.flatMap((item) => {
    const title = item.title || topic;
    const images = [];
    if (Array.isArray(item.images) && item.images.length) {
      item.images.forEach((image) => {
        if (image?.url && isUsableImageCandidate(image.url, image)) {
          images.push({
            title,
            link: image.url,
            width: image.width || 0,
            height: image.height || 0,
            contextLink: item.link,
            mime: "image/jpeg",
            source: item.source,
          });
        }
      });
    }
    if (!images.length && item.image && isUsableImageCandidate(item.image)) {
      images.push({
        title,
        link: item.image,
        width: 0,
        height: 0,
        contextLink: item.link,
        mime: "image/jpeg",
        source: item.source,
      });
    }
    return images;
  });

  const uniqueImages = dedupeImagesByUrl(researchImages).filter(
    (image) => !usedImages.has(normalizeImageUrl(image.link)),
  );

  const rankedImages = rankImageCandidates(topic, uniqueImages);

  return [...rankedImages, ...localImages].slice(
    0,
    Number(process.env.IMAGE_RESULTS_PER_TOPIC || 3),
  );
}

function isUsableImageCandidate(url, image = {}) {
  const normalizedUrl = String(url || "").toLowerCase();
  if (!/^https?:\/\//i.test(normalizedUrl)) return false;
  if (/\.(svg|ico)(\?|$)/i.test(normalizedUrl)) return false;
  if (
    /(logo|icon|sprite|avatar|author|profile|placeholder|default|favicon|apple-touch)/i.test(
      normalizedUrl,
    )
  ) {
    return false;
  }

  const area = Number(image.width || 0) * Number(image.height || 0);
  if (area > 0 && area < Number(process.env.MIN_IMAGE_AREA || 90000)) {
    return false;
  }

  return true;
}

function dedupeImagesByUrl(images) {
  const seen = new Set();
  return images.filter((image) => {
    const key = normalizeImageUrl(image.link);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rankImageCandidates(topic, images) {
  const topicWords = String(topic || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);

  return images.sort((a, b) => {
    const scoreA = imageCandidateScore(a, topicWords);
    const scoreB = imageCandidateScore(b, topicWords);
    return scoreB - scoreA;
  });
}

function imageCandidateScore(image, topicWords) {
  const area = Number(image.width || 0) * Number(image.height || 0);
  const haystack = [image.title, image.link, image.contextLink, image.source]
    .join(" ")
    .toLowerCase();
  const topicScore = topicWords.filter((word) => haystack.includes(word)).length;
  const sourcePenalty = /\/(tag|category|author|topics?)\//i.test(
    image.contextLink || "",
  )
    ? 50000
    : 0;
  return area + topicScore * 250000 - sourcePenalty;
}

async function readUsedImages() {
  try {
    const json = JSON.parse(await readFile(resolveUsedImagesPath(), "utf8"));
    return new Set(
      (Array.isArray(json) ? json : [])
        .map((item) => normalizeImageUrl(item.originalImageUrl || item.link || item))
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

async function markUsedImages(uploadedImages) {
  if (!uploadedImages?.length) return;

  const usedPath = resolveUsedImagesPath();
  let existing = [];
  try {
    existing = JSON.parse(await readFile(usedPath, "utf8"));
  } catch {
    existing = [];
  }

  const seen = new Set(
    existing
      .map((item) => normalizeImageUrl(item.originalImageUrl || item.link || item))
      .filter(Boolean),
  );
  for (const image of uploadedImages) {
    const key = normalizeImageUrl(image.originalImageUrl || image.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    existing.push({
      originalImageUrl: image.originalImageUrl || image.url,
      uploadedUrl: image.url || "",
      usedAt: new Date().toISOString(),
      site: selectedSite || "default",
    });
  }

  await mkdir(path.dirname(usedPath), { recursive: true });
  await writeFile(usedPath, JSON.stringify(existing.slice(-200), null, 2));
}

function resolveUsedImagesPath() {
  return path.join(root, "state", `used-images.${selectedSite || "default"}.json`);
}

function normalizeImageUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|wbraid|gbraid)/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return String(url || "").trim();
  }
}

async function localImagesForTopic(topic) {
  const imagesDir = path.join(root, "images");
  try {
    const files = await readdir(imagesDir);
    const words = topic
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2);
    return files
      .filter((file) => /\.(png|jpe?g|webp|gif)$/i.test(file))
      .map((file) => ({
        file,
        score: words.filter((word) => file.toLowerCase().includes(word)).length,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Number(process.env.IMAGE_RESULTS_PER_TOPIC || 3))
      .map(({ file }) => ({
        title: file.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "),
        link: path.join(imagesDir, file),
        contextLink: "",
        mime: mimeFromFilename(file),
        source: "local",
      }));
  } catch {
    return [];
  }
}

async function generateArticle(topic, research, context = {}) {
  const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  const schema = JSON.stringify(
    {
      title: "SEO title under 65 characters",
      slug: "url-slug",
      metaDescription: "150-160 character meta description",
      focusKeyword: "main keyword",
      secondaryKeywords: ["keyword 1", "keyword 2", "keyword 3"],
      articleHtml:
        "<h1>Main title</h1><p>Full article HTML with one h1, then h3/h4/h5 sections, detailed explanations, FAQ, and table of contents.</p>",
      imagePrompts: ["image idea 1", "image idea 2", "image idea 3"],
    },
    null,
    2,
  );

  const attempts = Number(process.env.ARTICLE_GENERATION_ATTEMPTS || 2);
  let lastError = null;
  let lastArticle = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const prompt = JSON.stringify(
      await buildArticlePromptPayload({
        topic,
        research,
        schema,
        context,
        attempt,
        previousValidationError: lastError,
      }),
      null,
      2,
    );
    const instructions =
      attempt === 1
        ? "The input is a JSON brief. Follow every field in that brief exactly and return only valid JSON matching output_schema."
        : "The input is a JSON brief. Fix the previous failure completely, especially previous_validation_error, and return only valid JSON matching output_schema.";

    let raw;
    if (provider === "openai") {
      raw = await callOpenAI({ instructions, prompt });
    } else {
      try {
        raw = await callGemini({ instructions, prompt });
      } catch (error) {
        if (process.env.OPENAI_API_KEY) {
          console.warn(
            `Gemini failed; falling back to OpenAI: ${error.message}`,
          );
          raw = await callOpenAI({ instructions, prompt });
        } else {
          throw error;
        }
      }
    }

    const article = normalizeArticleStructure(parseJsonObject(raw), topic, research);
    lastArticle = article;
    const validationError = validateArticleStructure(article.articleHtml);
    if (!validationError) {
      return maybeCopyEditArticle(article, topic, research, context);
    }
    lastError = validationError;
    console.warn(
      `Article validation failed on attempt ${attempt}: ${validationError}`,
    );
  }

  if (lastArticle && isWordCountValidationError(lastError)) {
    const expanded = await expandShortArticle(
      lastArticle,
      topic,
      research,
      context,
      provider,
      schema,
      lastError,
    );
    const expandedValidationError = validateArticleStructure(expanded.articleHtml);
    if (!expandedValidationError) {
      return maybeCopyEditArticle(expanded, topic, research, context);
    }
    lastError = expandedValidationError;
  }

  throw new Error(
    `Generated article did not meet publishing rules: ${lastError}`,
  );
}

async function buildArticlePromptPayload({
  topic,
  research,
  schema,
  context,
  attempt,
  previousValidationError,
}) {
  const promptTemplate = await renderPromptTemplate(resolvePromptTemplate(), {
    TOPIC: topic,
    RESEARCH_RESULTS: JSON.stringify(research, null, 2),
    ARTICLE_SCHEMA: schema,
    SITE_CONTEXT: context.siteContext || "No site context provided.",
    INTERNAL_LINKS: formatInternalLinksForPrompt(context.internalLinks || []),
  });

  return {
    task: "Write a WordPress-ready article and return only valid JSON.",
    attempt,
    topic,
    content_mode: (process.env.CONTENT_MODE || "").trim().toLowerCase() || null,
    audience: selectedSite.toLowerCase().includes("kafirana")
      ? "US news audience"
      : "general audience",
    site: selectedSite || "default",
    site_context: context.siteContext || "No site context provided.",
    approved_internal_links: context.internalLinks || [],
    research_results: research || [],
    output_schema: JSON.parse(schema),
    output_requirements: {
      return_only_json: true,
      no_markdown_fence: true,
      no_extra_intro_or_outro: true,
      fields_required: [
        "title",
        "slug",
        "metaDescription",
        "focusKeyword",
        "secondaryKeywords",
        "articleHtml",
        "imagePrompts",
      ],
    },
    editorial_rules: [
      "Use only the provided research snippets and links.",
      "Do not invent quotes, dates, figures, rankings, or unsupported claims.",
      "Lead with the most important update first.",
      "Put the direct answer or key update in the first 2 paragraphs.",
      "Use clear US English and concise paragraphs.",
      "Add context, why it matters, who is affected, and what to watch next.",
      "Prefer a specific, entity-led title over generic news phrasing.",
      "Make the article meaningfully better than a source summary.",
    ],
    seo_requirements: {
      min_words_after_stripping_html: Number(process.env.MIN_ARTICLE_WORDS || 600),
      max_words_after_stripping_html: Number(process.env.MAX_ARTICLE_WORDS || 2500),
      must_include_table_of_contents: true,
      must_include_faq: true,
      must_include_external_links: true,
      must_include_approved_internal_links: true,
      preferred_internal_link_count: "2-4",
      focus_keyword_rules: [
        "Include focus keyword in title.",
        "Include focus keyword in meta description.",
        "Include focus keyword in slug.",
        "Use focus keyword near the beginning of the article where natural.",
        "Use focus keyword naturally in some subheadings.",
      ],
      title_rules: [
        "Keep title highly clickable and accurate.",
        "Avoid generic prefixes such as US News Today, Latest News, Breaking News, or Trending News.",
        "Do not append generic trailing labels such as US News Update, US News Shift, Latest News, Top Headlines and Updates, or similar filler.",
        "Do not reuse bland patterns like Top Headlines and Updates.",
        "Prefer a specific person, company, event, place, consequence, or decision in the title.",
      ],
      aeo_rules: [
        "Answer-first formatting.",
        "Scannable sections and concise lists.",
        "Add quick facts, key takeaways, or quick answer near the top.",
        "Use question-style FAQ headings.",
      ],
    },
    html_rules: {
      exactly_one_h1: true,
      allowed_heading_tags_after_h1: ["h3", "h4", "h5"],
      disallow_h2: true,
      keep_headings_reasonably_short: true,
    },
    validation: {
      previous_validation_error: previousValidationError || null,
      instruction:
        previousValidationError
          ? "Your previous output failed validation. Fix that exact issue completely in this attempt."
          : "Pass validation on the first attempt.",
    },
    image_requirements: {
      image_prompt_count: 3,
      image_alt_should_use_focus_keyword: true,
    },
    reference_prompt: promptTemplate,
  };
}

async function maybeCopyEditArticle(article, topic, research, context = {}) {
  if (!getBooleanEnv("ARTICLE_COPY_EDIT_PASS", false)) return article;

  const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  const prompt = [
    "Copy edit this generated WordPress article for clarity, usefulness, trust, and SEO.",
    "Preserve all facts. Do not add unsupported claims, quotes, figures, dates, or named entities.",
    "Improve the title, meta description, opening clarity, section usefulness, FAQ answers, and internal-link fit where needed.",
    "Keep exactly one h1. Do not use h2 tags. Keep the article between 600 and 2500 words.",
    "Return only valid JSON with the same keys as the original article object.",
    "",
    `Topic: ${topic}`,
    "",
    "Site context:",
    context.siteContext || "No site context provided.",
    "",
    "Approved internal links:",
    formatInternalLinksForPrompt(context.internalLinks || []),
    "",
    "Research:",
    JSON.stringify(research, null, 2),
    "",
    "Article JSON:",
    JSON.stringify(article, null, 2),
  ].join("\n");

  try {
    const raw =
      provider === "openai"
        ? await callOpenAI({
            instructions: "Return only valid JSON matching the article schema.",
            prompt,
          })
        : await callGemini({
            instructions: "Return only valid JSON matching the article schema.",
            prompt,
          });
    const reviewed = normalizeArticleStructure(parseJsonObject(raw), topic, research);
    const validationError = validateArticleStructure(reviewed.articleHtml);
    if (validationError) {
      console.warn(`Copy-edit pass skipped: ${validationError}`);
      return article;
    }
    console.log("Copy-edit pass applied.");
    return reviewed;
  } catch (error) {
    console.warn(`Copy-edit pass skipped: ${error.message}`);
    return article;
  }
}

function isWordCountValidationError(error) {
  return /expected at least \d+ words, got \d+/i.test(String(error || ""));
}

async function expandShortArticle(
  article,
  topic,
  research,
  context,
  provider,
  schema,
  validationError,
) {
  const prompt = JSON.stringify(
    {
      task: "Expand the existing article so it passes the minimum word-count requirement while preserving facts and structure.",
      topic,
      site: selectedSite || "default",
      site_context: context.siteContext || "No site context provided.",
      approved_internal_links: context.internalLinks || [],
      research_results: research || [],
      previous_validation_error: validationError,
      output_schema: JSON.parse(schema),
      requirements: {
        return_only_json: true,
        keep_existing_facts_only: true,
        preserve_title_slug_meta_when_still_valid: true,
        min_words_after_stripping_html: Number(process.env.MIN_ARTICLE_WORDS || 600),
        max_words_after_stripping_html: Number(process.env.MAX_ARTICLE_WORDS || 2500),
        exactly_one_h1: true,
        disallow_h2: true,
        allowed_heading_tags_after_h1: ["h3", "h4", "h5"],
        must_expand_with: [
          "more concrete context",
          "why it matters",
          "who is affected",
          "what to watch next",
          "FAQ answers",
          "quick facts or key takeaways",
        ],
      },
      article_json: article,
    },
    null,
    2,
  );

  const instructions =
    "Expand the article substantially. Fix the word-count failure completely. Return only valid JSON matching output_schema.";

  let raw;
  if (provider === "openai") {
    raw = await callOpenAI({ instructions, prompt });
  } else {
    try {
      raw = await callGemini({ instructions, prompt });
    } catch (error) {
      if (process.env.OPENAI_API_KEY) {
        console.warn(`Gemini expansion failed; falling back to OpenAI: ${error.message}`);
        raw = await callOpenAI({ instructions, prompt });
      } else {
        throw error;
      }
    }
  }

  console.log("Applied short-article expansion pass.");
  return normalizeArticleStructure(parseJsonObject(raw), topic, research);
}

function formatInternalLinksForPrompt(internalLinks) {
  if (!internalLinks.length) return "No approved internal links provided.";
  return internalLinks
    .map((link) => `- ${link.anchor}: ${link.url}`)
    .join("\n");
}

function resolvePromptTemplate() {
  const explicitPrompt = (
    process.env.PROMPT_FILE || getArgValue("--prompt")
  ).trim();
  if (explicitPrompt) return explicitPrompt;

  const contentMode = (process.env.CONTENT_MODE || "").trim().toLowerCase();
  if (contentMode === "news") return "news-article-writer.md";
  if (contentMode === "ipo") return "ipo-gmp-writer.md";

  const siteName = selectedSite.toLowerCase();
  if (siteName.includes("kafirana") || siteName.includes("news")) {
    return "news-article-writer.md";
  }

  // Auto-detect IPO/GMP topics and use the IPO prompt automatically
  const topic = (customTopic || "").toLowerCase();
  const ipoKeywords = ["ipo", "gmp", "grey market", "listing price", "allotment", "subscription status"];
  if (ipoKeywords.some((kw) => topic.includes(kw))) {
    return "ipo-gmp-writer.md";
  }

  return "article-writer.md";
}

async function callGemini({ instructions, prompt }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey)
    throw new Error("Missing GEMINI_API_KEY in wordpress-auto-publisher/.env.");
  const models = getModelPool(
    process.env.GEMINI_MODEL,
    process.env.GEMINI_MODEL_POOL,
    "gemini-2.5-flash,gemini-3.7-flash,gemini-3.5-flash,gemini-2.5-flash-lite,gemini-3.5-flash-lite,gemini-2.5-pro,gemma-4-31b-it,gemma-4-26b-a4b-it",
  );
  const baseUrl = (
    process.env.GEMINI_API_URL ||
    "https://generativelanguage.googleapis.com/v1beta/models"
  ).replace(/\/+$/, "");
  const endpoint = ":generateContent";
  const errors = [];
  let authFailure = false;

  for (const model of models) {
    const url = `${baseUrl}/${model}${endpoint}`;
    let text;
    let json;
    let response;

    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: instructions }] },
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.55,
            responseMimeType: "application/json",
            responseSchema: articleResponseSchema(),
          },
        }),
      });
      text = await response.text();
      try {
        json = JSON.parse(text);
      } catch {
        const detail = text.trim() || `${response.status} ${response.statusText}`;
        throw new Error(
          `Gemini response was not valid JSON for ${url}: ${detail.slice(0, 400)}`,
        );
      }
    } catch (error) {
      errors.push(`${model}${endpoint}: ${error.message}`);
      continue;
    }

    if (response.ok) {
      console.log(`AI model selected: ${model}${endpoint}`);
      return extractGeminiText(json);
    }

    const message =
      json?.error?.message || response.statusText || text.slice(0, 200);
    errors.push(`${model}${endpoint}: ${response.status} ${message}`);
    if ([401, 403].includes(response.status)) {
      authFailure = true;
      break;
    }

    if (authFailure) break;
  }

  throw new Error(
    `Gemini failed after trying ${models.length} model(s):\n${errors.join("\n")}`,
  );
}

function articleResponseSchema() {
  return {
    type: "OBJECT",
    properties: {
      title: { type: "STRING" },
      slug: { type: "STRING" },
      metaDescription: { type: "STRING" },
      focusKeyword: { type: "STRING" },
      secondaryKeywords: {
        type: "ARRAY",
        items: { type: "STRING" },
      },
      articleHtml: { type: "STRING" },
      imagePrompts: {
        type: "ARRAY",
        items: { type: "STRING" },
      },
    },
    required: [
      "title",
      "slug",
      "metaDescription",
      "focusKeyword",
      "secondaryKeywords",
      "articleHtml",
      "imagePrompts",
    ],
    propertyOrdering: [
      "title",
      "slug",
      "metaDescription",
      "focusKeyword",
      "secondaryKeywords",
      "articleHtml",
      "imagePrompts",
    ],
  };
}

async function callOpenAI({ instructions, prompt }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey)
    throw new Error("Missing OPENAI_API_KEY in wordpress-auto-publisher/.env.");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      instructions,
      input: prompt,
      temperature: 0.55,
      text: {
        format: {
          type: "json_object",
        },
      },
    }),
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`OpenAI returned non-JSON response: ${text.slice(0, 400)}`);
  }

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
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
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

function normalizeArticleStructure(article, topic, research = []) {
  const normalized = { ...article };
  normalized.title = sanitizeGeneratedTitle(
    normalized.title || topic,
    topic,
    research,
  );
  normalized.slug = sanitizeGeneratedSlug(normalized.slug || normalized.title || topic);
  normalized.focusKeyword = sanitizeFocusKeyword(
    normalized.focusKeyword,
    normalized.title,
    topic,
  );
  const fallbackTitle =
    normalized.title || sanitizeGeneratedTitle(topic, topic, research);
  let html = String(normalized.articleHtml || "").trim();

  html = html.replace(/<h2(\b[^>]*)>/gi, "<h3$1>");
  html = html.replace(/<\/h2>/gi, "</h3>");
  html = html.replace(/<h6(\b[^>]*)>/gi, "<h5$1>");
  html = html.replace(/<\/h6>/gi, "</h5>");

  let seenH1 = false;
  html = html.replace(
    /<h1(\b[^>]*)>([\s\S]*?)<\/h1>/gi,
    (_match, attrs, content) => {
      if (!seenH1) {
        seenH1 = true;
        return `<h1${attrs}>${sanitizeGeneratedTitle(
          stripHtml(content),
          topic,
          research,
        )}</h1>`;
      }
      return `<h3${attrs}>${content}</h3>`;
    },
  );

  if (!seenH1) {
    html = `<h1>${escapeHtml(fallbackTitle)}</h1>\n\n${html}`;
  }

  normalized.articleHtml = html;
  return normalized;
}

function sanitizeFocusKeyword(focusKeyword, title, topic) {
  const cleaned = String(focusKeyword || "").trim().toLowerCase();
  const generic = new Set([
    "us news today",
    "us trending news",
    "us news update",
    "latest news",
    "trending news",
    "us news",
  ]);
  if (cleaned && !generic.has(cleaned)) {
    return focusKeyword;
  }

  const source = sanitizeGeneratedTitle(title || topic);
  const words = source
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2)
    .slice(0, 5);
  return words.join(" ") || cleaned || String(topic || "").trim().toLowerCase();
}

function sanitizeGeneratedTitle(title, topic = "", research = []) {
  let cleaned = String(title || "").trim();
  for (let index = 0; index < 3; index += 1) {
    const next = cleaned.replace(genericTitlePrefixPattern(), "").trim();
    if (next === cleaned) break;
    cleaned = next;
  }
  cleaned = stripGenericTitleSuffix(cleaned);
  if (!cleaned) {
    cleaned = String(title || "").trim();
  }
  if (isGenericGeneratedTitle(cleaned)) {
    const researchTitle = selectSpecificResearchTitle(research, topic);
    if (researchTitle) {
      return researchTitle;
    }
  }
  return cleaned;
}

function stripGenericTitleSuffix(title) {
  let cleaned = String(title || "").trim();
  const suffixPatterns = [
    /\s*[:\-–—|]\s*(us news update|us news shift|latest news|top headlines(?: and updates)?|news update|breaking news|trending news)\s*$/i,
    /\s*\b(us news update|us news shift|latest news|top headlines(?: and updates)?|news update|breaking news|trending news)\s*$/i,
  ];
  for (const pattern of suffixPatterns) {
    cleaned = cleaned.replace(pattern, "").trim();
  }
  return cleaned;
}

function isGenericGeneratedTitle(title) {
  const cleaned = String(title || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!cleaned) return true;
  if (genericTitlePrefixPattern().test(cleaned)) return true;
  return (
    /^(in|across|from) the us[:\-\s]+top headlines and updates$/.test(cleaned) ||
    /^(in us|in the us)[:\-\s]+top headlines and updates$/.test(cleaned) ||
    /top headlines and updates$/.test(cleaned) ||
    /latest (news|updates)( in| across)? the us$/.test(cleaned) ||
    /trending news( in| across)? us$/.test(cleaned)
  );
}

function selectSpecificResearchTitle(research, topic) {
  const genericTopicTerms = new Set(
    String(topic || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2),
  );

  for (const item of research || []) {
    const candidate = String(item?.title || "").trim();
    if (!candidate || isGenericGeneratedTitle(candidate)) continue;
    const normalized = sanitizeGeneratedTitle(candidate);
    const words = normalized
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2);
    const uniqueWords = words.filter((word) => !genericTopicTerms.has(word));
    if (uniqueWords.length >= 2) {
      return normalized;
    }
  }

  return "";
}

function sanitizeGeneratedSlug(slug) {
  let cleaned = slugify(slug || "");
  const prefixes = [
    "us-news-today",
    "us-trending-news",
    "us-news-update",
    "breaking-news",
    "latest-news",
    "trending-news",
  ];

  for (const prefix of prefixes) {
    if (cleaned === prefix) return "";
    if (cleaned.startsWith(`${prefix}-`)) {
      cleaned = cleaned.slice(prefix.length + 1);
      break;
    }
  }

  return cleaned;
}

function validateArticleStructure(articleHtml) {
  const text = stripHtml(articleHtml);
  const wordCount = countWords(text);
  const minWords = Number(process.env.MIN_ARTICLE_WORDS || 600);
  const maxWords = Number(process.env.MAX_ARTICLE_WORDS || 2500);
  const minWordGrace = Number(process.env.MIN_ARTICLE_WORDS_GRACE || 25);
  const h1Count = (articleHtml.match(/<h1\b/gi) || []).length;
  const h2Count = (articleHtml.match(/<h2\b/gi) || []).length;

  if (h1Count !== 1) return `expected exactly 1 h1, got ${h1Count}`;
  if (h2Count !== 0) return `expected 0 h2 tags, got ${h2Count}`;
  if (wordCount < Math.max(0, minWords - minWordGrace))
    return `expected at least ${minWords} words, got ${wordCount}`;
  if (wordCount > maxWords)
    return `expected at most ${maxWords} words, got ${wordCount}`;

  const sections = splitSectionsByHeading(articleHtml);
  for (const section of sections) {
    const headingText = stripHtml(section.heading).replace(/\s+/g, " ").trim();
    if (/^h[3-5]$/i.test(section.tag)) {
      if (isUtilityHeading(headingText)) {
        continue;
      }
      if (headingText.length > 95) {
        return `heading too long: "${headingText.slice(0, 95)}"`;
      }
    }
  }

  return null;
}

function runSeoQualityGate({
  article,
  html,
  research,
  images,
  internalLinks,
  slug,
}) {
  const issues = getSeoQualityIssues({
    article,
    html,
    research,
    images,
    internalLinks,
    slug,
  });
  if (!issues.length) {
    console.log("SEO quality gate passed.");
    return;
  }

  const message = [
    "SEO quality gate found issues:",
    ...issues.map((issue) => `- ${issue}`),
  ].join("\n");

  if (getBooleanEnv("SEO_GATE_STRICT", false)) {
    throw new Error(message);
  }

  console.warn(message);
}

function getSeoQualityIssues({
  article,
  html,
  research,
  images,
  internalLinks,
  slug,
}) {
  const issues = [];
  const text = stripHtml(html);
  const focusKeyword = String(article.focusKeyword || "").trim();
  const title = String(article.title || "");
  const metaDescription = String(article.metaDescription || "");
  const lowerHtml = String(html || "").toLowerCase();

  if (title.length > 65) issues.push(`SEO title is ${title.length} chars; target <= 65.`);
  if (hasGenericTitlePrefix(title)) {
    issues.push(
      `Title uses a repetitive generic prefix; prefer a specific entity/event opening instead.`,
    );
  }
  if (metaDescription.length < 120 || metaDescription.length > 165) {
    issues.push(
      `Meta description is ${metaDescription.length} chars; target 150-160.`,
    );
  }
  if (focusKeyword) {
    const lowerKeyword = focusKeyword.toLowerCase();
    if (!title.toLowerCase().includes(lowerKeyword)) {
      issues.push(`Focus keyword "${focusKeyword}" missing from title.`);
    }
    if (!metaDescription.toLowerCase().includes(lowerKeyword)) {
      issues.push(`Focus keyword "${focusKeyword}" missing from meta description.`);
    }
    if (!slug.toLowerCase().includes(slugify(focusKeyword).slice(0, 24))) {
      issues.push(`Focus keyword "${focusKeyword}" may be missing from slug.`);
    }
  } else {
    issues.push("Missing focus keyword.");
  }

  if (!/<h3\b[^>]*>[\s\S]*?(table of contents|key takeaways|quick facts|quick answer)/i.test(html)) {
    issues.push("Missing table of contents, quick answer, quick facts, or key takeaways section.");
  }
  if (!/<h3\b[^>]*>[\s\S]*?(faq|frequently asked questions)/i.test(html)) {
    issues.push("Missing FAQ section.");
  }
  if (!/<a\s+[^>]*href=["']https?:\/\//i.test(html)) {
    issues.push("Missing crawlable external or internal links.");
  }

  const approvedInternalUrlCount = (internalLinks || []).filter((link) =>
    lowerHtml.includes(String(link.url || "").toLowerCase()),
  ).length;
  if (internalLinks?.length && approvedInternalUrlCount < 1) {
    issues.push("No approved internal links found in final HTML.");
  }

  if ((research || []).length < 2) issues.push("Fewer than 2 research sources were collected.");
  if (!images?.length) issues.push("No image was uploaded or attached.");
  if (countWords(text) < Number(process.env.MIN_ARTICLE_WORDS || 600)) {
    issues.push("Final HTML is below minimum word count.");
  }

  return issues;
}

function hasGenericTitlePrefix(title) {
  return genericTitlePrefixPattern().test(String(title || "").trim());
}

function genericTitlePrefixPattern() {
  return /^(us news today|us trending news|us news update|breaking news|latest news|trending news)(?:\s*[:\-–—]\s*|\s+)/i;
}

function splitSectionsByHeading(articleHtml) {
  const matches = [
    ...articleHtml.matchAll(/<(h[1-5])\b[^>]*>([\s\S]*?)<\/\1>/gi),
  ];
  if (!matches.length) return [];

  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end =
      index + 1 < matches.length
        ? (matches[index + 1].index ?? articleHtml.length)
        : articleHtml.length;
    const headingHtml = match[0];
    return {
      tag: match[1],
      heading: headingHtml,
      body: articleHtml.slice(start + headingHtml.length, end),
    };
  });
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function countWords(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function isUtilityHeading(headingText) {
  const normalized = String(headingText || "")
    .trim()
    .toLowerCase();
  return [
    "table of contents",
    "faq",
    "faqs",
    "quick answer",
    "quick answers",
  ].includes(normalized);
}

async function generateAiImage(topic, focusKeyword, slug) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const imageModels = [
    "gemini-3.1-flash-image-preview",
    "gemini-3.1-flash-image",
    "gemini-3-pro-image-preview",
    "nano-banana-pro-preview",
    "gemini-2.5-flash-image",
  ];

  const prompt = `Generate a high quality, modern, editorial style featured photo for a digital publication about: ${topic}. Focus keyword: ${focusKeyword || topic}. Clean composition, photorealistic, professional lighting, no watermarks, no distorted text.`;

  for (const model of imageModels) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    try {
      console.log(`Attempting AI image generation with model: ${model}...`);
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "image/jpeg",
          },
        }),
      });

      if (!response.ok) continue;

      const data = await response.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.inlineData && part.inlineData.data) {
          const buffer = Buffer.from(part.inlineData.data, "base64");
          const filename = `${slug}-ai-generated.jpeg`;
          const uploaded = await uploadWordPressMedia({
            filename,
            contentType: part.inlineData.mimeType || "image/jpeg",
            buffer,
            altText: `${focusKeyword || topic} Featured Illustration`,
          });
          console.log(`✅ Successfully generated AI image using ${model}!`);
          return {
            ...uploaded,
            sourceUrl: "https://generativelanguage.googleapis.com",
            originalImageUrl: "ai-generated",
          };
        }
      }
    } catch (err) {
      console.warn(`AI image generation failed with ${model}:`, err.message);
    }
  }
  return null;
}

async function uploadImages(images, slug, topic = "", focusKeyword = "") {
  const uploads = [];
  const desiredUploads = Number(process.env.IMAGES_PER_POST || 1);
  const selectedImages = images.slice(0, Number(process.env.IMAGE_UPLOAD_ATTEMPTS || 5));
  for (let index = 0; index < selectedImages.length; index += 1) {
    if (uploads.length >= desiredUploads) break;
    const image = selectedImages[index];
    try {
      const local = image.source === "local";
      const response = local ? null : await fetch(image.link);
      if (response && !response.ok)
        throw new Error(`${response.status} ${response.statusText}`);
      const buffer = local
        ? await readFile(image.link)
        : Buffer.from(await response.arrayBuffer());
      const contentType = local
        ? image.mime
        : response.headers.get("content-type") || image.mime || "image/jpeg";
      const extension = mimeToExtension(contentType);
      const filename = `${slug}-${index + 1}.${extension}`;
      const uploaded = await uploadWordPressMedia({
        filename,
        contentType,
        buffer,
        altText: image.title,
      });
      uploads.push({
        ...uploaded,
        sourceUrl: image.contextLink,
        originalImageUrl: image.link,
      });
    } catch (error) {
      console.warn(`Image skipped: ${image.link} (${error.message})`);
    }
  }

  // Fallback to Gemini AI Image Generation if no images were found or downloaded
  if (!uploads.length) {
    console.log("No web images available. Triggering AI image generation fallback...");
    const aiImage = await generateAiImage(topic, focusKeyword, slug);
    if (aiImage) {
      uploads.push(aiImage);
    }
  }

  return uploads;
}

async function uploadWordPressMedia({
  filename,
  contentType,
  buffer,
  altText,
}) {
  const url = `${wordpressBaseUrl()}/wp-json/wp/v2/media`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: wordpressAuthHeader(),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": contentType,
    },
    body: buffer,
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `WordPress Media API returned non-JSON response (${response.status} ${response.statusText}): ${text.slice(0, 300)}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `WordPress media upload failed: ${JSON.stringify(json, null, 2)}`,
    );
  }

  if (altText) {
    await fetch(`${url}/${json.id}`, {
      method: "POST",
      headers: {
        Authorization: wordpressAuthHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ alt_text: altText }),
    });
  }

  return {
    id: json.id,
    url: json.source_url,
    alt: altText,
  };
}

async function createWordPressPost({
  title,
  content,
  excerpt,
  slug,
  featuredMedia,
  focusKeyword,
}) {
  requireWordPressConfig();
  await verifyWordPressAccess();
  const body = {
    title,
    content,
    excerpt,
    slug,
    status: getValidWordPressStatus(),
    meta: {
      rank_math_focus_keyword: focusKeyword || title.split(" ").slice(0, 4).join(" "),
      rank_math_title: title,
      rank_math_description: excerpt ? String(excerpt).replace(/<[^>]+>/g, "").slice(0, 155) : title,
      rank_math_robots: ["index", "follow"],
      rank_math_rich_snippet: "article",
    },
  };

  if (featuredMedia) body.featured_media = featuredMedia;
  const categoryIds = await resolveDefaultCategoryIds();
  if (categoryIds.length) body.categories = categoryIds;
  addIdList(body, "tags", process.env.WP_DEFAULT_TAG_IDS);

  const response = await fetchWithRetry(`${wordpressBaseUrl()}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: {
      Authorization: wordpressAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `WordPress REST API returned non-JSON response (${response.status} ${response.statusText}): ${text.slice(0, 300)}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `WordPress post creation failed: ${JSON.stringify(json, null, 2)}`,
    );
  }
  return json;
}

function resolveSiteCta(siteUrl, topic, focusKw) {
  const url = String(siteUrl || "").toLowerCase();
  if (url.includes("elitebulletin")) {
    return `
<div class="eb-cta-box" style="background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 12px; padding: 24px; color: #ffffff; margin: 35px 0; text-align: center; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1);">
  <h4 style="color: #38bdf8; margin: 0 0 10px 0; font-size: 20px;">📱 Get Instant IPO & GMP Alerts</h4>
  <p style="color: #cbd5e1; font-size: 15px; margin: 0 0 18px 0; line-height: 1.5;">Never miss upcoming IPO subscription dates, live grey market premiums, and allotment announcements.</p>
  <a href="https://elitebulletin.in/category/ipo-gmp-analysis/" style="display: inline-block; background: #e11d48; color: #ffffff; padding: 12px 26px; font-weight: bold; border-radius: 6px; text-decoration: none; font-size: 15px;">Explore Live IPO Hub →</a>
</div>`;
  }
  if (url.includes("kafirana")) {
    return `
<div class="kafirana-cta-box" style="background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%); border-radius: 12px; padding: 24px; color: #ffffff; margin: 35px 0; text-align: center; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1);">
  <h4 style="color: #60a5fa; margin: 0 0 10px 0; font-size: 20px;">📩 Join 50,000+ Daily Readers</h4>
  <p style="color: #cbd5e1; font-size: 15px; margin: 0 0 18px 0; line-height: 1.5;">Get unbiased US breaking news, policy updates, and trending stories delivered fresh every morning.</p>
  <a href="https://kafirana.com/category/us-news/" style="display: inline-block; background: #2563eb; color: #ffffff; padding: 12px 26px; font-weight: bold; border-radius: 6px; text-decoration: none; font-size: 15px;">Read Latest US Headlines →</a>
</div>`;
  }
  return `
<div class="general-cta-box" style="background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 12px; padding: 24px; color: #ffffff; margin: 35px 0; text-align: center;">
  <h4 style="color: #38bdf8; margin: 0 0 10px 0; font-size: 20px;">🚀 Master AI & Modern Digital Growth</h4>
  <p style="color: #cbd5e1; font-size: 15px; margin: 0 0 18px 0;">Explore step-by-step automation tutorials, SEO strategies, and expert guides.</p>
  <a href="${siteUrl}" style="display: inline-block; background: #0284c7; color: #ffffff; padding: 12px 26px; font-weight: bold; border-radius: 6px; text-decoration: none;">Explore More Guides →</a>
</div>`;
}

function buildPostHtml(article, research, images, slug, internalLinks = []) {
  const focusKw = article.focusKeyword || article.title.split(" ").slice(0, 4).join(" ");
  const rawHtml = stripLeadingH1(article.articleHtml);
  const siteUrl = wordpressBaseUrl();

  // 1. Build In-Body Image with Focus Keyword in Alt text
  let inBodyImage = "";
  if (images && images.length) {
    const mainImg = images[0];
    const imgSrc = mainImg.sourceUrl || mainImg.originalImageUrl || mainImg.url || "";
    if (imgSrc) {
      inBodyImage = `
<figure class="wp-block-image size-large" style="margin: 25px 0;">
  <img src="${escapeHtml(imgSrc)}" alt="${escapeHtml(focusKw)} Guide and Analysis" style="width: 100%; border-radius: 8px;" />
  <figcaption style="text-align: center; font-size: 13px; color: #64748b; margin-top: 6px;">${escapeHtml(focusKw)} - Key Insights & Data</figcaption>
</figure>`;
    }
  }

  // 2. Build BLUF (Bottom Line Up Front) Quick Summary Box
  const summaryText = article.metaDescription || `Essential insights and key takeaways regarding ${focusKw} for smart decision-making.`;
  const blufBox = `
<div class="bluf-quick-verdict" style="background: #f0fdf4; border: 1px solid #bbf7d0; border-left: 5px solid #16a34a; border-radius: 8px; padding: 18px 22px; margin: 20px 0;">
  <p style="margin: 0 0 6px 0; font-weight: bold; color: #166534; font-size: 16px;">⚡ Quick Takeaway (BLUF):</p>
  <p style="margin: 0; color: #15803d; font-size: 15px; line-height: 1.6;">${escapeHtml(summaryText)}</p>
</div>`;

  // 3. Build HTML Table of Contents with Jump Anchors
  let tocHtml = "";
  const h2Matches = [...rawHtml.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)];
  if (h2Matches.length >= 2) {
    const tocItems = h2Matches.slice(0, 6).map((m, idx) => {
      const headingText = stripHtml(m[1]).trim();
      const anchor = headingText.toLowerCase().replace(/[\W_]+/g, "-").replace(/^-+|-+$/g, "");
      return `<li><a href="#${anchor}">${idx + 1}. ${escapeHtml(headingText)}</a></li>`;
    });
    tocHtml = `
<div class="rank-math-toc-block" style="background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 20px; margin: 25px 0;">
  <h3 style="margin-top: 0; margin-bottom: 12px; font-size: 18px; color: #0f172a;">Table of Contents</h3>
  <ul style="margin: 0; padding-left: 20px; line-height: 1.8;">
    ${tocItems.join("\n    ")}
  </ul>
</div>`;
  }

  // 4. Inject Jump Anchors into H2 headings
  let anchoredHtml = rawHtml.replace(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi, (match, attrs, content) => {
    const headingText = stripHtml(content).trim();
    const anchor = headingText.toLowerCase().replace(/[\W_]+/g, "-").replace(/^-+|-+$/g, "");
    return `<h2 id="${anchor}"${attrs}>${content}</h2>`;
  });

  // 5. Opening Hook with Focus Keyword in first 10%
  const openingHook = `<p>When reviewing <strong>${escapeHtml(focusKw)}</strong>, it is crucial to understand the latest market trends, official data, and key takeaways.</p>`;

  // 6. Site-Specific High Converting CTA Box
  const ctaBox = resolveSiteCta(siteUrl, article.title, focusKw);

  // 7. Combine with Related Internal Links
  const linkedHtml = addRelatedInternalLinks(anchoredHtml, internalLinks);

  const fullBody = [openingHook, blufBox, tocHtml, inBodyImage, linkedHtml, ctaBox].filter(Boolean).join("\n\n");

  const structuredData = buildStructuredData({
    article,
    research,
    images,
    slug,
    bodyHtml: fullBody,
  });
  return [fullBody, structuredData].filter(Boolean).join("\n\n");
}

function stripLeadingH1(articleHtml) {
  return String(articleHtml || "").replace(
    /^\s*<h1\b[^>]*>[\s\S]*?<\/h1>\s*/i,
    "",
  );
}

function addRelatedInternalLinks(articleHtml, internalLinks) {
  const usefulLinks = selectUsefulInternalLinks(articleHtml, internalLinks);
  if (!usefulLinks.length) return articleHtml;

  const existingUrls = new Set(
    [...String(articleHtml || "").matchAll(/href=["']([^"']+)["']/gi)].map(
      (match) => match[1],
    ),
  );
  const missingLinks = usefulLinks.filter((link) => !existingUrls.has(link.url));
  if (!missingLinks.length) return articleHtml;

  const items = missingLinks
    .slice(0, Number(process.env.RELATED_INTERNAL_LINKS || 3))
    .map(
      (link) =>
        `<li><a href="${escapeHtml(link.url)}">${escapeHtml(link.anchor)}</a></li>`,
    )
    .join("");

  return `${articleHtml}\n\n<h3>Related Reading</h3>\n<ul>${items}</ul>`;
}

function selectUsefulInternalLinks(articleHtml, internalLinks) {
  const text = stripHtml(articleHtml).toLowerCase();
  const scored = internalLinks.map((link) => {
    const keyword = String(link.keyword || link.anchor || "").toLowerCase();
    const anchor = String(link.anchor || "").toLowerCase();
    const score =
      (keyword && text.includes(keyword) ? 2 : 0) +
      (anchor && text.includes(anchor) ? 1 : 0);
    return { ...link, score };
  });

  const matched = scored.filter((link) => link.score > 0);
  return (matched.length ? matched : scored)
    .sort((a, b) => b.score - a.score)
    .slice(0, Number(process.env.RELATED_INTERNAL_LINKS || 3));
}

function buildStructuredData({ article, research, images, slug, bodyHtml }) {
  const blocks = [
    buildOrganizationJsonLd(),
    buildBreadcrumbJsonLd({ article, slug }),
    buildArticleJsonLd({ article, research, images, slug }),
    buildFaqJsonLd(bodyHtml),
  ].filter(Boolean);

  if (!blocks.length) return "";

  return blocks.map(jsonLdScript).join("\n");
}

function buildArticleJsonLd({ article, research, images, slug }) {
  const siteUrl = wordpressBaseUrl();
  if (!siteUrl) return null;

  const canonicalUrl = `${siteUrl}/${slug}/`;
  const now = new Date().toISOString();
  const imageUrl = images?.[0]?.url || images?.[0]?.sourceUrl || "";
  const citations = (research || [])
    .map((item) => item.link)
    .filter(Boolean)
    .slice(0, 8);

  const json = {
    "@context": "https://schema.org",
    "@type": resolveArticleSchemaType(),
    headline: article.title,
    description: article.metaDescription,
    mainEntityOfPage: canonicalUrl,
    url: canonicalUrl,
    datePublished: now,
    dateModified: now,
    author: {
      "@type": "Person",
      name: process.env.WP_AUTHOR_NAME || process.env.WP_USERNAME || "Editor",
    },
    publisher: {
      "@type": "Organization",
      name: siteDisplayName(siteUrl),
    },
    articleSection: resolveArticleSection(),
    isAccessibleForFree: true,
    keywords: [
      article.focusKeyword,
      ...(Array.isArray(article.secondaryKeywords)
        ? article.secondaryKeywords
        : []),
    ].filter(Boolean),
  };

  if (imageUrl) json.image = [imageUrl];
  if (citations.length) json.citation = citations;

  return json;
}

function buildOrganizationJsonLd() {
  const siteUrl = wordpressBaseUrl();
  if (!siteUrl) return null;

  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: siteDisplayName(siteUrl),
    url: siteUrl,
  };
}

function buildBreadcrumbJsonLd({ article, slug }) {
  const siteUrl = wordpressBaseUrl();
  if (!siteUrl) return null;

  const section = resolveArticleSection();
  const sectionUrl = resolveSectionUrl(siteUrl, section);
  const postUrl = `${siteUrl}/${slug}/`;

  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: siteUrl,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: section,
        item: sectionUrl,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: article.title,
        item: postUrl,
      },
    ],
  };
}

function resolveSectionUrl(siteUrl, section) {
  const explicitUrl =
    process.env.WP_BREADCRUMB_SECTION_URL ||
    process.env.WP_CATEGORY_URL ||
    "";
  if (/^https?:\/\//i.test(explicitUrl)) {
    return explicitUrl.replace(/\/?$/, "/");
  }

  const categoryName = process.env.WP_DEFAULT_CATEGORY_NAME || section;
  return `${siteUrl}/category/${slugify(categoryName)}/`;
}

function resolveArticleSchemaType() {
  return isNewsContent() ? "NewsArticle" : "BlogPosting";
}

function resolveArticleSection() {
  if (selectedSite.toLowerCase().includes("kafirana")) return "News";
  if (isNewsContent()) return "News";
  return "AI";
}

function isNewsContent() {
  const contentMode = (process.env.CONTENT_MODE || "").trim().toLowerCase();
  const promptFile = (
    process.env.PROMPT_FILE ||
    getArgValue("--prompt") ||
    ""
  ).toLowerCase();
  const siteName = selectedSite.toLowerCase();
  return (
    contentMode === "news" ||
    promptFile.includes("news") ||
    siteName.includes("kafirana") ||
    siteName.includes("news")
  );
}

function siteDisplayName(siteUrl = wordpressBaseUrl()) {
  return (
    process.env.WP_SITE_NAME ||
    process.env.SITE_NAME ||
    selectedSite ||
    new URL(siteUrl).hostname
  );
}

function buildFaqJsonLd(articleHtml) {
  const faqs = extractFaqs(articleHtml);
  if (!faqs.length) return null;

  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.answer,
      },
    })),
  };
}

function extractFaqs(articleHtml) {
  const html = String(articleHtml || "");
  const headingPattern = /<(h[3-5])\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const headings = [...html.matchAll(headingPattern)];
  const faqs = [];
  let inFaq = false;

  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index];
    const tag = current[1].toLowerCase();
    const headingText = stripHtml(current[2]);
    const headingStart = current.index ?? 0;
    const bodyStart = headingStart + current[0].length;
    const bodyEnd =
      index + 1 < headings.length
        ? headings[index + 1].index ?? html.length
        : html.length;
    const body = html.slice(bodyStart, bodyEnd);

    if (/^(faq|faqs|frequently asked questions)$/i.test(headingText)) {
      inFaq = true;
      continue;
    }

    if (inFaq && tag === "h3") {
      break;
    }

    if (inFaq && /[?？]$/.test(headingText)) {
      const answer = stripHtml(body);
      if (answer) {
        faqs.push({
          question: headingText,
          answer,
        });
      }
    }
  }

  return faqs.slice(0, 8);
}

function jsonLdScript(data) {
  const json = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
  return `<script type="application/ld+json">${json}</script>`;
}

async function writeSocialContentOutput({ article, topic, url, slug }) {
  if (!url || !getBooleanEnv("GENERATE_SOCIAL_OUTPUT", true)) return;

  const socialDir = path.join(root, "output", "social", selectedSite || "default");
  await mkdir(socialDir, { recursive: true });
  const outputPath = path.join(socialDir, `${slug}.json`);
  const social = buildSocialContent({ article, topic, url });
  await writeFile(outputPath, JSON.stringify(social, null, 2));
  console.log(`Social content saved: ${path.relative(root, outputPath)}`);
}

function buildSocialContent({ article, topic, url }) {
  const title = String(article.title || topic).trim();
  const description = String(article.metaDescription || "").trim();
  const keyword = String(article.focusKeyword || topic).trim();
  const hashtags = buildHashtags(keyword, selectedSite);
  const shortTitle = title.length > 92 ? `${title.slice(0, 89).trim()}...` : title;

  return {
    topic,
    title,
    url,
    focusKeyword: keyword,
    x: `${shortTitle}\n\n${description}\n\n${url}\n\n${hashtags.slice(0, 3).join(" ")}`.trim(),
    facebook: `${title}\n\n${description}\n\nRead more: ${url}`.trim(),
    linkedin: [
      title,
      "",
      description,
      "",
      `Why it matters: ${keyword} is changing quickly, and this update gives readers the key context without the noise.`,
      "",
      url,
      "",
      hashtags.join(" "),
    ].join("\n").trim(),
    whatsapp: `${title}\n${description}\n${url}`.trim(),
    headlineVariants: [
      title,
      `${keyword}: What changed and why it matters`,
      `What to know about ${keyword} now`,
    ],
  };
}

function buildHashtags(keyword, siteName) {
  const base = String(keyword || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join("");
  const siteTag = siteName
    ? `#${siteName.replace(/[^a-z0-9]/gi, "")}`
    : "";
  return [
    base ? `#${base.replace(/[^a-z0-9]/gi, "")}` : "",
    siteTag,
    isNewsContent() ? "#News" : "#AI",
    "#Trending",
  ].filter(Boolean);
}

async function updateLlmsTxt({ title, topic, url }) {
  if (!url) return;

  const llmsPath = resolveLlmsPath();
  let content;
  try {
    content = await readFileWithFallback(
      llmsPath,
      selectedSite ? path.join(root, "llms.txt") : "",
    );
  } catch {
    return;
  }

  const articleLine = `- [${title}](${url})`;
  if (content.includes(articleLine)) {
    return;
  }

  const sectionHeading = "## Latest Published Articles";
  if (content.includes(sectionHeading)) {
    content = content.replace(
      sectionHeading,
      `${sectionHeading}\n${articleLine}`,
    );
  } else {
    content = `${content.trim()}\n\n${sectionHeading}\n${articleLine}\n`;
  }

  content = trimLatestArticlesSection(
    content,
    Number(process.env.LLMS_MAX_ARTICLES || 20),
  );
  content = updateLlmsTopicList(content, topic);
  await writeFile(llmsPath, content);
  console.log(`Updated llms.txt: ${title}`);
}

function trimLatestArticlesSection(content, maxItems) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex(
    (line) => line.trim() === "## Latest Published Articles",
  );
  if (start === -1) return content;

  let end = start + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end])) {
    end += 1;
  }

  const sectionLines = lines
    .slice(start + 1, end)
    .filter((line) => line.trim());
  const articleLines = sectionLines.filter((line) =>
    line.trim().startsWith("- "),
  );
  const trimmedArticleLines = articleLines.slice(0, maxItems);
  const rebuiltSection = [
    "## Latest Published Articles",
    ...trimmedArticleLines,
  ];

  return (
    [...lines.slice(0, start), ...rebuiltSection, ...lines.slice(end)]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n"
  );
}

function updateLlmsTopicList(content, topic) {
  const normalizedTopic = String(topic || "").trim();
  if (!normalizedTopic) return content;

  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "## Core Topics");
  if (start === -1) return content;

  let end = start + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end])) {
    end += 1;
  }

  const existingItems = lines
    .slice(start + 1, end)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));

  const normalizedExisting = new Set(
    existingItems.map((line) => line.slice(2).trim().toLowerCase()),
  );
  if (!normalizedExisting.has(normalizedTopic.toLowerCase())) {
    existingItems.push(`- ${normalizedTopic}`);
  }

  const rebuiltSection = ["## Core Topics", ...existingItems];
  return (
    [...lines.slice(0, start), ...rebuiltSection, ...lines.slice(end)]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n"
  );
}

function wordpressBaseUrl() {
  return (process.env.WP_BASE_URL || "").replace(/\/$/, "");
}

function wordpressAuthHeader() {
  requireWordPressConfig();
  const token = Buffer.from(
    `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`,
  ).toString("base64");
  return `Basic ${token}`;
}

function requireWordPressConfig() {
  if (
    !process.env.WP_BASE_URL ||
    !process.env.WP_USERNAME ||
    !process.env.WP_APP_PASSWORD
  ) {
    throw new Error(
      "Missing WP_BASE_URL, WP_USERNAME, or WP_APP_PASSWORD in wordpress-auto-publisher/.env.",
    );
  }
}

async function verifyWordPressAccess() {
  if (wordpressAccessVerified) return;
  const response = await fetch(
    `${wordpressBaseUrl()}/wp-json/wp/v2/users/me?context=edit`,
    {
      headers: {
        Authorization: wordpressAuthHeader(),
      },
    },
  );
  const json = await response.json();
  if (!response.ok) {
    throw new Error(
      [
        "WordPress authentication failed.",
        `Response: ${JSON.stringify(json, null, 2)}`,
        "Check WP_BASE_URL, WP_USERNAME, WP_APP_PASSWORD, and the user's role.",
        "The WordPress user should usually be Author, Editor, or Administrator.",
      ].join("\n"),
    );
  }
  wordpressAccessVerified = true;
}

function addIdList(body, key, value) {
  if (!value) return;
  const ids = value
    .split(",")
    .map((id) => Number(id.trim()))
    .filter(Boolean);
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
    `${wordpressBaseUrl()}/wp-json/wp/v2/categories?per_page=100`,
    {
      headers: {
        Authorization: wordpressAuthHeader(),
      },
    },
  );
  const json = await response.json();
  if (!response.ok) {
    throw new Error(
      `Could not load WordPress categories: ${JSON.stringify(json, null, 2)}`,
    );
  }

  const clean = (s) =>
    String(s || "")
      .replace(/&amp;/g, "&")
      .replace(/&#038;/g, "&")
      .toLowerCase()
      .trim();

  const normalized = clean(categoryName);
  const exactMatch = json.find(
    (item) => clean(item.name) === normalized || clean(item.slug) === slugify(categoryName),
  );

  if (exactMatch) {
    cachedCategoryIds = [exactMatch.id];
    return cachedCategoryIds;
  }

  // Partial match or fallback to first valid non-uncategorized category
  const partialMatch = json.find(
    (item) =>
      item.id !== 1 &&
      (clean(item.name).includes(normalized) || normalized.includes(clean(item.name))),
  );

  if (partialMatch) {
    cachedCategoryIds = [partialMatch.id];
    return cachedCategoryIds;
  }

  const firstValid = json.find((item) => item.id !== 1) || json[0];
  if (firstValid) {
    cachedCategoryIds = [firstValid.id];
    return cachedCategoryIds;
  }

  cachedCategoryIds = [];
  return cachedCategoryIds;
}

function getModelPool(fixedModel, configuredPool, fallbackPool) {
  const allModels = (configuredPool || fallbackPool)
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean)
    .filter((model) => !model.toLowerCase().includes("tts"));

  if (fixedModel?.trim()) {
    const primary = fixedModel.trim();
    const remaining = allModels.filter((m) => m !== primary);
    return [primary, ...remaining];
  }
  return shuffle(allModels);
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
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "article"
  );
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

function getRandomItems(array, count) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
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
      `Invalid WP_POST_STATUS="${process.env.WP_POST_STATUS}". Use one of: publish, future, draft, pending, private.`,
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

async function fetchWithRetry(url, options = {}, retries = 3, delayMs = 1500) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, options);
      return response;
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`[Network Retry] Fetch attempt ${attempt} failed for ${url}: ${err.message}. Retrying in ${delayMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 1.5;
    }
  }
}

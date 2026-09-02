#!/usr/bin/env node
/**
 * fetch_ipo_topics.mjs
 * Real-time active IPO tracking engine for EliteBulletin.
 * Scrapes current active and upcoming IPOs with their live GMP data,
 * generates daily lifecycle topics (Day-by-Day GMP, Allotment, Listing prediction),
 * and injects them into topics.elitebulletin.txt.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const topicsFile = path.join(root, "topics.elitebulletin.txt");

const SOURCES = [
  "https://ipowatch.in/ipo-grey-market-premium-latest-ipo-gmp/",
  "https://www.chittorgarh.com/report/ipo-in-india-list-main-board-sme/82/",
];

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return await res.text();
}

function parseIpoRows(html) {
  const ipoNames = new Set();
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;

  while ((match = rowRegex.exec(html)) !== null) {
    const rowHtml = match[1];
    const cellRegex = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      cells.push(
        cellMatch[2]
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&nbsp;/g, " ")
          .trim()
      );
    }

    if (cells.length >= 2) {
      const name = cells[0];
      if (
        name &&
        name.length > 3 &&
        name.length < 70 &&
        !/^(ipo|company|name|sme|mainboard|nse|bse|issue|security|symbol|allotment|price|gmp)/i.test(name)
      ) {
        const cleanName = name
          .replace(/\s+IPO\b/i, "")
          .replace(/\s+SME\b/i, "")
          .replace(/\s+Limited\b/i, "")
          .replace(/\s+Ltd\.?\b/i, "")
          .trim();
        if (cleanName.length >= 3) {
          ipoNames.add(cleanName);
        }
      }
    }
  }

  return Array.from(ipoNames);
}

function buildDailyIpoTopics(companyName) {
  const name = companyName.trim();
  const today = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return [
    `${name} IPO GMP today: Latest Grey Market Premium & expected listing gains (${today})`,
    `${name} IPO subscription status & day by day bidding analysis`,
    `${name} IPO allotment status check: Link Intime, KFintech & BSE direct link`,
    `${name} IPO listing date prediction, GMP trend and listing day strategy`,
  ];
}

async function main() {
  console.log("Scraping live Indian IPO market data...");
  const activeCompanies = new Set();

  for (const url of SOURCES) {
    try {
      console.log(`Fetching: ${url}`);
      const html = await fetchHtml(url);
      const names = parseIpoRows(html);
      console.log(`Extracted ${names.length} active IPO companies from ${url}`);
      names.slice(0, 15).forEach((n) => activeCompanies.add(n));
    } catch (err) {
      console.warn(`Error fetching ${url}: ${err.message}`);
    }
  }

  if (!activeCompanies.size) {
    console.log("No active IPO names extracted. Preserving existing topics.");
    return;
  }

  let existingContent = "";
  try {
    existingContent = await readFile(topicsFile, "utf8");
  } catch {
    existingContent = "# EliteBulletin topics\n";
  }

  const existingLines = existingContent.split(/\r?\n/).map((l) => l.trim().toLowerCase());
  const newTopics = [];

  for (const company of activeCompanies) {
    const topics = buildDailyIpoTopics(company);
    for (const topic of topics) {
      if (!existingLines.includes(topic.toLowerCase())) {
        newTopics.push(topic);
        existingLines.push(topic.toLowerCase());
      }
    }
  }

  if (!newTopics.length) {
    console.log("All current active IPO topics are already in topics.elitebulletin.txt.");
    return;
  }

  const separator = `\n# --- Daily Active IPO Analysis (${new Date().toISOString().slice(0, 10)}) ---\n`;
  const updatedContent = existingContent.trimEnd() + separator + newTopics.join("\n") + "\n";

  await writeFile(topicsFile, updatedContent, "utf8");
  console.log(`✅ Injected ${newTopics.length} new active IPO topics for daily coverage!`);
  newTopics.slice(0, 8).forEach((t) => console.log(`  + ${t}`));
}

main().catch((err) => {
  console.error("Failed to fetch IPO topics:", err.message);
  process.exit(1);
});

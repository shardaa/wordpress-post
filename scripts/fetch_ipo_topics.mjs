#!/usr/bin/env node
/**
 * fetch_ipo_topics.mjs
 * Fetches upcoming and active IPO names from Chittorgarh and adds new ones
 * to topics.elitebulletin.txt so the publisher pipeline picks them up.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import http from "node:http";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const topicsFile = path.join(root, "topics.elitebulletin.txt");

const IPO_SOURCES = [
  "https://www.chittorgarh.com/report/ipo_dashboard/",
  "https://ipowatch.in/upcoming-ipo-calendar-dates-issues-prices/",
  "https://www.moneycontrol.com/ipo/",
];

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return await res.text();
}

function extractIpoNames(html) {
  const names = new Set();

  // Match company names from common IPO page patterns
  const patterns = [
    /<td[^>]*>\s*<a[^>]*>([A-Z][A-Za-z0-9\s&.-]{3,60}?)(?:\s+IPO)?<\/a>\s*<\/td>/g,
    /class="[^"]*ipo[^"]*"[^>]*>([A-Z][A-Za-z0-9\s&.-]{3,60}?)(?:\s+IPO)?</gi,
    /<strong>([A-Z][A-Za-z0-9\s&.-]{3,60}?)\s+IPO<\/strong>/g,
    /title="([A-Z][A-Za-z0-9\s&.-]{3,60}?)\s+IPO/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const name = match[1].trim();
      if (name.length > 3 && name.length < 60 && !/^(the|ipo|gmp|nse|bse|sebi)$/i.test(name)) {
        names.add(name);
      }
    }
  }

  return [...names];
}

function buildTopicVariants(companyName) {
  const base = companyName.trim();
  return [
    `${base} IPO GMP today analysis and review`,
    `${base} IPO allotment status check guide`,
    `${base} IPO listing price prediction and expected gains`,
  ];
}

async function readExistingTopics() {
  try {
    const text = await readFile(topicsFile, "utf8");
    return text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

async function main() {
  console.log("Fetching upcoming IPO data...");

  const existingTopics = await readExistingTopics();
  const existingSet = new Set(existingTopics.map(t => t.toLowerCase()));
  const newTopics = [];

  for (const url of IPO_SOURCES) {
    try {
      console.log(`Fetching: ${url}`);
      const html = await fetchPage(url);
      const names = extractIpoNames(html);
      console.log(`Found ${names.length} IPO names from ${url}`);

      for (const name of names) {
        const variants = buildTopicVariants(name);
        for (const topic of variants) {
          if (!existingSet.has(topic.toLowerCase())) {
            newTopics.push(topic);
            existingSet.add(topic.toLowerCase());
          }
        }
      }
    } catch (err) {
      console.warn(`Skipped ${url}: ${err.message}`);
    }
  }

  if (!newTopics.length) {
    console.log("No new IPO topics found. topics.elitebulletin.txt is up to date.");
    return;
  }

  // Read full file to preserve comments and existing content
  let existingContent = "";
  try {
    existingContent = await readFile(topicsFile, "utf8");
  } catch {
    existingContent = "# Elite Bulletin topics\n";
  }

  const separator = "\n# Auto-fetched IPO topics (" + new Date().toISOString().slice(0, 10) + ")\n";
  const newContent = existingContent.trimEnd() + separator + newTopics.join("\n") + "\n";

  await writeFile(topicsFile, newContent, "utf8");
  console.log(`Added ${newTopics.length} new IPO topics to topics.elitebulletin.txt`);
  newTopics.forEach(t => console.log(`  + ${t}`));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";

const site = process.env.SITE;
const displayName = process.env.DISPLAY_NAME || site;
const envFile = `${site}.env`;

if (!fs.existsSync(envFile)) {
  console.error(`Env file ${envFile} does not exist.`);
  process.exit(1);
}

const content = fs.readFileSync(envFile, "utf8");
const lines = content.split(/\r?\n/);
const envMap = {};

for (const line of lines) {
  const idx = line.indexOf("=");
  if (idx !== -1 && !line.startsWith("#")) {
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    envMap[k] = v;
  }
}

let key = envMap.GEMINI_API_KEY || "";
if (!key && envMap.GEMINI_API_KEYS) {
  key = envMap.GEMINI_API_KEYS.split(",")[0].trim();
}

if (!key && envMap.OPENAI_API_KEY) {
  key = envMap.OPENAI_API_KEY.trim();
}

if (key) {
  fs.appendFileSync(envFile, `\nGEMINI_API_KEY=${key}\n`);
  fs.writeFileSync(".env", fs.readFileSync(envFile));
  console.log(`::add-mask::${key}`);
  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, `GEMINI_API_KEY=${key}\n`);
  }
  console.log(`Successfully exported runtime GEMINI_API_KEY for ${displayName}`);
} else {
  console.error(`Could not find GEMINI_API_KEY, GEMINI_API_KEYS, or OPENAI_API_KEY in ${envFile}`);
  process.exit(1);
}

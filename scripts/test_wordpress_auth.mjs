#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  await loadLocalEnv(path.join(root, ".env"));
  const baseUrl = (process.env.WP_BASE_URL || "").replace(/\/$/, "");
  const username = process.env.WP_USERNAME || "";
  const appPassword = process.env.WP_APP_PASSWORD || "";

  if (!baseUrl || !username || !appPassword) {
    throw new Error("Missing WP_BASE_URL, WP_USERNAME, or WP_APP_PASSWORD in wordpress-auto-publisher/.env.");
  }

  const response = await fetch(`${baseUrl}/wp-json/wp/v2/users/me?context=edit`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${appPassword}`).toString("base64")}`
    }
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(
      [
        "WordPress auth test failed.",
        JSON.stringify(json, null, 2),
        "Check the URL, username, application password, and user role."
      ].join("\n")
    );
  }

  console.log(`Authenticated as: ${json.name || json.slug || username}`);
  console.log(`User id: ${json.id}`);
  console.log("WordPress REST auth is working.");
} catch (error) {
  console.error(error.message);
  process.exit(1);
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
    // no-op
  }
}

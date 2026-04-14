#!/usr/bin/env node
import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const publicDir = path.join(root, "public");
const outputDir = path.join(root, "output");
const stateFile = path.join(root, "state", "processed.json");
const topicsFile = path.join(root, "topics.txt");
const port = Number(process.env.PORT || 3000);

const jobState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  success: null,
  code: null,
  currentTopic: null,
  logs: [],
  lastOutput: null
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      return serveFile(res, path.join(publicDir, "index.html"), "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/app.js") {
      return serveFile(res, path.join(publicDir, "app.js"), "text/javascript; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname.startsWith("/output/")) {
      const fileName = path.basename(url.pathname);
      return serveFile(res, path.join(outputDir, fileName), "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/status") {
      return sendJson(res, 200, await buildStatusPayload());
    }

    if (req.method === "GET" && url.pathname === "/topics") {
      return sendJson(res, 200, { topics: await readTopics() });
    }

    if (req.method === "POST" && url.pathname === "/generate") {
      if (jobState.running) {
        return sendJson(res, 409, { ok: false, message: "A generation job is already running." });
      }
      const body = await readJsonBody(req);
      startGenerationJob(body?.topic || "");
      return sendJson(res, 202, { ok: true, message: "Generation started." });
    }

    sendJson(res, 404, { ok: false, message: "Not found" });
  } catch (error) {
    sendJson(res, 500, { ok: false, message: error.message });
  }
});

server.listen(port, () => {
  console.log(`WordPress Auto Publisher UI running on http://0.0.0.0:${port}`);
});

function startGenerationJob(topic = "") {
  jobState.running = true;
  jobState.startedAt = new Date().toISOString();
  jobState.finishedAt = null;
  jobState.success = null;
  jobState.code = null;
  jobState.currentTopic = topic || null;
  jobState.logs = [];

  const args = ["scripts/publish_articles.mjs", "--research=browser"];
  if (topic) {
    args.push(`--topic=${topic}`);
  }

  const child = spawn(
    process.execPath,
    args,
    {
      cwd: root,
      env: {
        ...process.env,
        ARTICLE_LIMIT: process.env.ARTICLE_LIMIT || "1",
        BROWSER_HEADLESS: process.env.BROWSER_HEADLESS || "true"
      }
    }
  );

  child.stdout.on("data", (chunk) => appendLogs(String(chunk)));
  child.stderr.on("data", (chunk) => appendLogs(String(chunk)));

  child.on("close", async (code) => {
    jobState.running = false;
    jobState.finishedAt = new Date().toISOString();
    jobState.code = code;
    jobState.success = code === 0;
    jobState.lastOutput = await getLatestOutputSummary();
  });
}

function appendLogs(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    jobState.logs.push(line);
    if (line.startsWith("Researching: ")) {
      jobState.currentTopic = line.replace("Researching: ", "");
    }
  }
  jobState.logs = jobState.logs.slice(-200);
}

async function buildStatusPayload() {
  return {
    ...jobState,
    lastOutput: jobState.lastOutput || await getLatestOutputSummary()
  };
}

async function getLatestOutputSummary() {
  try {
    const files = await readdir(outputDir);
    const htmlFiles = files.filter((file) => file.endsWith(".html")).sort();
    const processed = JSON.parse(await readFile(stateFile, "utf8"));
    const latestProcessed = Object.entries(processed)
      .sort((a, b) => new Date(b[1].createdAt || 0) - new Date(a[1].createdAt || 0))[0];

    const latestHtml = htmlFiles[htmlFiles.length - 1] || null;
    return {
      latestHtmlFile: latestHtml,
      latestHtmlPath: latestHtml ? `/output/${latestHtml}` : null,
      latestProcessedTopic: latestProcessed?.[0] || null,
      latestWordPressLink: latestProcessed?.[1]?.wordpressLink || null,
      latestWordPressId: latestProcessed?.[1]?.wordpressId || null
    };
  } catch {
    return null;
  }
}

async function readTopics() {
  const text = await readFile(topicsFile, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

async function serveFile(res, filePath, contentType) {
  const content = await readFile(filePath);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

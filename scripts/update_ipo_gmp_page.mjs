#!/usr/bin/env node
/**
 * update_ipo_gmp_page.mjs
 * Dedicated Real-Time IPO GMP Tracker Engine for EliteBulletin.
 * 
 * - Scrapes live upcoming and active unlisted IPOs with real-time GMP rates.
 * - Filters out all previously listed IPOs.
 * - Formats a mobile-responsive, modern financial table with color-coded gain badges.
 * - Publishes or updates the static WordPress page at /ipo-gmp-today/ via REST API.
 * - Injects Rank Math SEO schema and metadata for maximum search visibility.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, "elitebulletin.env");

async function loadEnv() {
  try {
    const raw = await readFile(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const idx = line.indexOf("=");
      if (idx !== -1 && !line.startsWith("#")) {
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) process.env[key] = val;
      }
    }
  } catch (err) {
    console.warn("Could not read elitebulletin.env:", err.message);
  }
}

async function scrapeLiveGmpData() {
  const url = "https://ipowatch.in/ipo-grey-market-premium-latest-ipo-gmp/";
  console.log(`Scraping live GMP data from ${url}...`);

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!res.ok) throw new Error(`Failed to fetch IPOWatch: HTTP ${res.status}`);
  const html = await res.text();

  const ipoList = [];
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

    if (cells.length >= 7) {
      const name = cells[0];
      const gmp = cells[1];
      const price = cells[3];
      const gain = cells[4] || "";
      const dates = cells[5] || "";
      const statusRaw = (cells[6] || "").toLowerCase();

      // Filter out table headers or invalid rows
      if (
        !name ||
        name.length < 3 ||
        /^(ipo|company|name|sme|mainboard|nse|bse|symbol|price|gmp)/i.test(name)
      ) {
        continue;
      }

      // STRICT FILTER: Exclude already listed shares
      const isListed = statusRaw.includes("listed") || /listed/i.test(gain) || /listed/i.test(rowHtml);
      if (isListed) continue;

      // Filter condition: Must be actively OPEN, or UPCOMING with fixed confirmed dates, or CLOSED waiting for listing day
      const hasFixedDates = /\d+/.test(dates) && !/tba|tbd|-/i.test(dates);
      const isOpen = statusRaw.includes("open");
      const isUpcomingWithDate = statusRaw.includes("upcoming") && hasFixedDates;
      const isClosedWaitingListing = statusRaw.includes("closed") && hasFixedDates;

      if (!isOpen && !isUpcomingWithDate && !isClosedWaitingListing) {
        continue;
      }

      const cleanName = name
        .replace(/\s+IPO\b/i, "")
        .replace(/\s+SME\b/i, "")
        .replace(/\s+Limited\b/i, "")
        .replace(/\s+Ltd\.?\b/i, "")
        .trim();

      const type = /sme/i.test(name) ? "SME" : "Mainboard";
      let statusBadge = "UPCOMING";
      if (isOpen) statusBadge = "OPEN NOW";
      else if (isClosedWaitingListing) statusBadge = "AWAITING LISTING";

      ipoList.push({
        name: cleanName,
        fullName: name,
        type,
        gmp: gmp || "₹0",
        price: price || "₹-",
        gain: gain || "0%",
        dates: dates || "Announced",
        statusBadge,
      });
    }
  }

  // Deduplicate and filter to active unlisted only
  const seen = new Set();
  const filtered = [];
  for (const item of ipoList) {
    if (!seen.has(item.name.toLowerCase())) {
      seen.add(item.name.toLowerCase());
      filtered.push(item);
    }
  }

  console.log(`Found ${filtered.length} currently open or upcoming confirmed-date IPOs.`);
  return filtered;
}

function buildGmpPageHtml(ipoList) {
  const istNow = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Kolkata",
    dateStyle: "full",
    timeStyle: "short",
  });

  const rowsHtml = ipoList
    .map((ipo) => {
      const isPositive = !ipo.gain.includes("-") && !ipo.gmp.includes("₹0") && !ipo.gmp.includes("₹-");
      const isNegative = ipo.gain.includes("-");
      const badgeBg = isPositive ? "#ecfdf5" : isNegative ? "#fef2f2" : "#f8fafc";
      const badgeColor = isPositive ? "#059669" : isNegative ? "#dc2626" : "#64748b";
      const typeBadgeBg = ipo.type === "Mainboard" ? "#e0f2fe" : "#fef3c7";
      const typeColor = ipo.type === "Mainboard" ? "#0369a1" : "#b45309";

      let statusColor = "#0284c7";
      let statusBg = "#f0f9ff";
      if (ipo.statusBadge === "OPEN NOW") {
        statusColor = "#16a34a";
        statusBg = "#dcfce7";
      } else if (ipo.statusBadge === "AWAITING LISTING") {
        statusColor = "#ea580c";
        statusBg = "#ffedd5";
      }

      return `      <tr style="border-bottom: 1px solid #f1f5f9; transition: background 0.2s;">
        <td style="padding: 16px 14px; font-weight: 600; color: #0f172a;">
          <div style="font-size: 15px; margin-bottom: 4px;">${ipo.name}</div>
          <span style="background: ${typeBadgeBg}; color: ${typeColor}; font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 600; text-transform: uppercase;">${ipo.type}</span>
        </td>
        <td style="padding: 16px 14px;">
          <span style="background: ${statusBg}; color: ${statusColor}; font-size: 12px; padding: 4px 10px; border-radius: 6px; font-weight: 700; white-space: nowrap;">
            ${ipo.statusBadge}
          </span>
          <div style="color: #64748b; font-size: 12px; margin-top: 4px; font-weight: 500;">${ipo.dates}</div>
        </td>
        <td style="padding: 16px 14px; color: #334155; font-weight: 600; font-size: 15px;">${ipo.price}</td>
        <td style="padding: 16px 14px; font-weight: 700; color: #0f172a; font-size: 16px;">${ipo.gmp}</td>
        <td style="padding: 16px 14px;">
          <span style="background: ${badgeBg}; color: ${badgeColor}; padding: 6px 12px; border-radius: 6px; font-weight: 700; font-size: 14px; display: inline-block;">
            ${ipo.gain}
          </span>
        </td>
        <td style="padding: 16px 14px; text-align: center;">
          <a href="https://elitebulletin.in/?s=${encodeURIComponent(ipo.name)}" style="background: #1e293b; color: #ffffff; padding: 6px 12px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600; display: inline-block;">
            Review &rarr;
          </a>
        </td>
      </tr>`;
    })
    .join("\n");

  return `<!-- wp:html -->
<div class="eb-gmp-tracker-container" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1000px; margin: 0 auto; color: #1e293b;">

  <!-- Header Card -->
  <div style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); color: #ffffff; padding: 28px 24px; border-radius: 12px; margin-bottom: 25px; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1);">
    <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
      <div>
        <span style="background: #e11d48; color: #ffffff; font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.5px;">Live Active Tracker</span>
        <h1 style="color: #ffffff; margin: 10px 0 6px 0; font-size: 26px; font-weight: 700; line-height: 1.3;">IPO GMP Today: Live Grey Market Premium Tracker</h1>
        <p style="color: #94a3b8; font-size: 14px; margin: 0;">Real-time grey market rates and expected gains for IPOs open for subscription or confirmed for bidding.</p>
      </div>
      <div style="background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 8px; padding: 10px 16px; text-align: right;">
        <div style="color: #38bdf8; font-size: 11px; text-transform: uppercase; font-weight: 700; margin-bottom: 2px;">⚡ Auto-Updated Every 3 Hours</div>
        <div style="color: #f1f5f9; font-size: 13px; font-weight: 600;">${istNow} IST</div>
      </div>
    </div>
  </div>

  <!-- Key Info Summary Box -->
  <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 18px 22px; margin-bottom: 25px;">
    <h3 style="margin: 0 0 8px 0; font-size: 16px; color: #0f172a;">📌 Active Watchlist Criteria:</h3>
    <ul style="margin: 0; padding-left: 20px; color: #475569; font-size: 14px; line-height: 1.6;">
      <li><strong>Open for Apply:</strong> IPOs currently accepting bidding applications from retail and HNI investors.</li>
      <li><strong>Upcoming with Fixed Dates:</strong> Issues with confirmed official bidding window dates announced.</li>
      <li><strong>Automatic Removal on Listing:</strong> As soon as an issue rings the bell on NSE/BSE, it is automatically removed from this unlisted tracker.</li>
    </ul>
  </div>

  <!-- Live Responsive Table -->
  <div style="overflow-x: auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); margin-bottom: 30px;">
    <table style="width: 100%; border-collapse: collapse; text-align: left; min-width: 720px;">
      <thead>
        <tr style="background: #f8fafc; border-bottom: 2px solid #e2e8f0; color: #475569; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px;">
          <th style="padding: 14px; font-weight: 700;">IPO Company</th>
          <th style="padding: 14px; font-weight: 700;">Status & Bidding Dates</th>
          <th style="padding: 14px; font-weight: 700;">Issue Price</th>
          <th style="padding: 14px; font-weight: 700;">GMP Today (₹)</th>
          <th style="padding: 14px; font-weight: 700;">Est. Listing Gain (%)</th>
          <th style="padding: 14px; font-weight: 700; text-align: center;">Action</th>
        </tr>
      </thead>
      <tbody>
${rowsHtml}
      </tbody>
    </table>
  </div>

  <!-- High Converting CTA Card -->
  <div style="background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 12px; padding: 26px; color: #ffffff; text-align: center; margin: 35px 0; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1);">
    <h3 style="color: #38bdf8; margin: 0 0 10px 0; font-size: 22px; font-weight: 700;">📱 Never Miss a High-GMP IPO Opportunity</h3>
    <p style="color: #cbd5e1; font-size: 15px; margin: 0 0 20px 0; max-width: 650px; margin-left: auto; margin-right: auto; line-height: 1.5;">
      Get instant grey market premium movements, subscription milestones, and allotment announcements delivered right to your smartphone before bidding closes.
    </p>
    <a href="https://elitebulletin.in/category/ipo-gmp-analysis/" style="display: inline-block; background: #e11d48; color: #ffffff; font-weight: 700; font-size: 15px; padding: 12px 28px; border-radius: 8px; text-decoration: none; box-shadow: 0 4px 12px rgba(225, 29, 72, 0.3);">
      Explore In-Depth IPO Reviews &rarr;
    </a>
  </div>

  <!-- FAQ Section for Search Ranking -->
  <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; margin-top: 30px;">
    <h2 style="font-size: 20px; color: #0f172a; margin: 0 0 16px 0;">Frequently Asked Questions (FAQ)</h2>
    
    <h3 style="font-size: 16px; color: #0f172a; margin: 14px 0 6px 0;">What is IPO Grey Market Premium (GMP)?</h3>
    <p style="color: #475569; font-size: 14px; margin: 0 0 12px 0; line-height: 1.6;">IPO GMP is the premium at which IPO shares are bought and sold unofficially before they list on stock exchanges like NSE and BSE. A high positive GMP indicates strong retail and institutional demand.</p>

    <h3 style="font-size: 16px; color: #0f172a; margin: 14px 0 6px 0;">Is IPO GMP guaranteed profit on listing day?</h3>
    <p style="color: #475569; font-size: 14px; margin: 0 0 12px 0; line-height: 1.6;">No. GMP is market-driven and unofficial. While it serves as a strong indicator of market sentiment, broader equity market volatility on listing day can impact the final opening price.</p>

    <h3 style="font-size: 16px; color: #0f172a; margin: 14px 0 6px 0;">When is an IPO removed from this live GMP tracker?</h3>
    <p style="color: #475569; font-size: 14px; margin: 0; line-height: 1.6;">IPOs remain on this live dashboard until the morning of their official listing date. Once listed, they transition into standard equity trading on the stock exchange and are automatically cleared from this tracker.</p>
  </div>

</div>
<!-- /wp:html -->`;
}

async function publishOrUpdateGmpPage(pageHtml) {
  const baseUrl = (process.env.WP_BASE_URL || "https://elitebulletin.in").replace(/\/+$/, "");
  const username = process.env.WP_USERNAME;
  const password = process.env.WP_APP_PASSWORD;

  if (!username || !password) {
    throw new Error("Missing WP_USERNAME or WP_APP_PASSWORD in elitebulletin.env");
  }

  const token = Buffer.from(`${username}:${password}`).toString("base64");
  const authHeader = `Basic ${token}`;

  // 1. Check if page already exists with slug 'ipo-gmp-today'
  const checkRes = await fetch(`${baseUrl}/wp-json/wp/v2/pages?slug=ipo-gmp-today`, {
    headers: { Authorization: authHeader },
  });

  const existingPages = checkRes.ok ? await checkRes.json() : [];
  const existingPage = existingPages[0];

  const payload = {
    title: "IPO GMP Today: Live Grey Market Premium Tracker (Updated Every 3 Hours)",
    content: pageHtml,
    slug: "ipo-gmp-today",
    status: "publish",
    meta: {
      rank_math_focus_keyword: "IPO GMP today",
      rank_math_title: "IPO GMP Today: Live Grey Market Premium Tracker (2026)",
      rank_math_description: "Live IPO GMP today tracker with real-time grey market premium, estimated listing gains, lot sizes, and dates for active unlisted Mainboard & SME IPOs in India.",
      rank_math_robots: ["index", "follow"],
      rank_math_rich_snippet: "article",
    },
  };

  let resultPage;
  if (existingPage) {
    console.log(`Updating existing IPO GMP page (ID: ${existingPage.id})...`);
    const updateRes = await fetch(`${baseUrl}/wp-json/wp/v2/pages/${existingPage.id}`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    resultPage = await updateRes.json();
  } else {
    console.log("Creating new IPO GMP page...");
    const createRes = await fetch(`${baseUrl}/wp-json/wp/v2/pages`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    resultPage = await createRes.json();
  }

  console.log(`✅ Live IPO GMP Page Ready: ${resultPage.link || `${baseUrl}/ipo-gmp-today/`}`);
}

async function main() {
  await loadEnv();
  const ipoList = await scrapeLiveGmpData();
  if (!ipoList.length) {
    console.log("No active IPOs found to update.");
    return;
  }
  const pageHtml = buildGmpPageHtml(ipoList);
  await publishOrUpdateGmpPage(pageHtml);
}

main().catch((err) => {
  console.error("Failed to update IPO GMP page:", err);
  process.exit(1);
});

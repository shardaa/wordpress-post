#!/usr/bin/env node
import "dotenv/config";
import process from "node:process";

const sites = [
  {
    name: "EliteBulletin",
    baseUrl: "https://elitebulletin.in",
    auth: "Basic " + Buffer.from("shardaashish097@gmail.com:9n9W acCi HaX6 d5Mc Jcmy ldEL").toString("base64")
  },
  {
    name: "Kafirana",
    baseUrl: "https://kafirana.com",
    auth: "Basic " + Buffer.from("ashish:aKHq FkaP qmxw 8bbr VOLm FXoI").toString("base64")
  }
];

async function auditSite(site) {
  console.log(`\n======================================================`);
  console.log(`🔍 [AGENT 3 AUDIT] Auditing Site: ${site.name} (${site.baseUrl})`);
  console.log(`======================================================`);

  try {
    const res = await fetch(`${site.baseUrl}/wp-json/wp/v2/posts?per_page=20&status=publish,future`, {
      headers: { Authorization: site.auth }
    });
    if (!res.ok) {
      console.log(`❌ Failed to fetch posts from ${site.name}: ${res.statusText}`);
      return;
    }
    const posts = await res.json();
    console.log(`Found ${posts.length} posts to audit.\n`);

    let passedCount = 0;
    let issuesFound = 0;

    for (const post of posts) {
      const title = post.title?.rendered || "Untitled";
      const content = post.content?.rendered || "";
      const words = content.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
      
      const hasToc = content.includes("rank-math-toc-block") || content.includes("Table of Contents");
      const hasImage = content.includes("<img ") || content.includes("<figure ");
      const hasInternalLink = content.includes(site.baseUrl.replace("https://", ""));
      const hasBluf = content.includes("bluf-quick-verdict") || content.includes("Quick Takeaway");
      const hasCta = content.includes("-cta-box");

      const issues = [];
      if (words < 500) issues.push(`Low word count (${words} words)`);
      if (!hasToc) issues.push("Missing Table of Contents");
      if (!hasImage) issues.push("Missing In-Body Image");
      if (!hasInternalLink) issues.push("Missing Internal Category Link");

      if (issues.length === 0) {
        console.log(`✅ [100/100 Perfect] Post #${post.id}: "${title.slice(0, 45)}..." (${words} words)`);
        passedCount++;
      } else {
        console.log(`⚠️ [Needs Polish] Post #${post.id}: "${title.slice(0, 45)}..."`);
        issues.forEach(i => console.log(`    ↳ ❌ ${i}`));
        issuesFound++;
      }
    }

    console.log(`\n📊 ${site.name} Audit Summary:`);
    console.log(`   • Perfect 100/100 Posts: ${passedCount}`);
    console.log(`   • Posts Needing Polish: ${issuesFound}`);
    console.log(`   • Site Health Score: ${Math.round((passedCount / (posts.length || 1)) * 100)}%`);

  } catch (err) {
    console.error(`Audit error on ${site.name}:`, err.message);
  }
}

async function main() {
  for (const site of sites) {
    await auditSite(site);
  }
}

main();

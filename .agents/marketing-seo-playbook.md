# Project Marketing SEO Playbook

This file is local to this app. It distills the marketing skill ideas that are useful for the WordPress publisher without installing any global agent skills.

## Goal

Publish articles that can rank faster by being more useful, easier to extract, and easier for Google and AI answer engines to trust.

## Article Rules

- Match one clear search intent. Do not mix broad beginner coverage with unrelated news angles.
- Lead with the answer or update in the first 2 paragraphs.
- Add information gain: what changed, why it matters, who it affects, what readers should do next, and what is still uncertain.
- Use source-backed claims. Do not invent dates, stats, rankings, quotes, or named features.
- Include concise definition blocks for entities, products, models, tools, or technical terms.
- Use scannable sections: short paragraphs, bullets, tables, and FAQ-style questions.
- Include E-E-A-T signals where natural: source attribution, named companies, official announcements, expert context from research, and clear limits.
- Use internal links naturally with descriptive anchor text. If an exact URL is unavailable, use a clear internal-link placeholder.
- Include external links only when they support a claim or help the reader verify the update.
- Write titles for both Search and Discover: specific, current, emotionally clear, and accurate.
- Avoid fake urgency, exaggerated promises, keyword stuffing, and unsupported "best" claims.

## Fast Ranking Checklist

- Focus keyword appears in title, slug, meta description, opening paragraph, and at least one subheading.
- Meta description answers why the article is worth clicking in 150-160 characters.
- First screen gives a direct answer, not a slow introduction.
- Article includes a table of contents and a useful FAQ section.
- FAQ questions are phrased like real searches.
- Every major claim is either from the provided research or clearly framed as analysis.
- Article includes schema-friendly FAQ formatting.
- Article adds at least one unique angle beyond source summaries.
- Article is useful on mobile: short paragraphs, no huge walls of text.
- Article links to relevant older posts and relevant external sources.

## Priority Local Skill Stack

Use these project-local skills in this order. This stack should take priority over the older generic SEO/AEO prompt rules whenever there is a conflict.

1. product-marketing-context: use the correct HealingPoint or Kafirana audience, tone, topics, and positioning before writing.
2. site-architecture/internal-linking: use approved internal links and strengthen topical clusters before adding generic SEO advice.
3. content-strategy: match search intent, freshness, topic cluster value, and reader usefulness.
4. ai-seo: make answers easy for Google, AI Overviews, ChatGPT, Gemini, Perplexity, and other answer engines to extract and cite.
5. seo-audit/quality-gate: check title, meta, keyword placement, FAQ, links, sources, images, schema, and word count before publishing.
6. schema-markup: add accurate JSON-LD only for content that exists on the page.
7. copy-editing: improve clarity, trust, usefulness, and "so what?" value without changing facts.
8. social-content: create distribution copy after publishing.

Older generic rules like keyword density, power words, and clickable titles are still useful, but they are secondary. Never sacrifice accuracy, site fit, internal-link quality, or reader usefulness just to satisfy a generic SEO rule.

## Implemented In This App

- `.agents/product-marketing-context.md` gives each site audience, tone, topics, and internal-link priorities.
- `data/internal-links.healingpoint.json` and `data/internal-links.kafirana.json` provide approved internal links.
- Article prompts receive site context and approved internal links before generation.
- Final post HTML adds a small related-reading block if approved internal links were not already used.
- Pre-publish SEO quality gate checks title length, meta length, keyword placement, FAQ/key-takeaway presence, links, source count, image presence, and word count.
- JSON-LD schema now includes Organization, BreadcrumbList, NewsArticle or BlogPosting, and FAQPage when FAQs are present.
- Optional copy-edit pass can polish articles before publishing with `ARTICLE_COPY_EDIT_PASS=true`.
- Social sharing copy is saved after publishing under `output/social/<site>/<slug>.json`.
- Repetitive generic news title prefixes are stripped after generation, including `US News Today:`, `US Trending News:`, `US News Update:`, `Breaking News:`, `Latest News:`, and `Trending News:`.
- Kafirana browser research expands broad news hub pages into specific article pages before selecting images, filters logo/icon/placeholder images, remembers used image URLs, and tries fallback image candidates.

## Useful Env Switches

- `SEO_GATE_STRICT=true` blocks publishing when the SEO quality gate finds issues. Default is warn-only.
- `ARTICLE_COPY_EDIT_PASS=true` runs a second AI quality pass. Default is off to save API usage.
- `GENERATE_SOCIAL_OUTPUT=false` disables social copy files. Default is on.
- `RELATED_INTERNAL_LINKS=3` controls how many related links can be appended.
- `WP_BREADCRUMB_SECTION_URL=https://example.com/category/name/` overrides the generated breadcrumb category URL.
- `IMAGE_UPLOAD_ATTEMPTS=5` controls how many image candidates are tried before giving up.
- `MIN_IMAGE_AREA=90000` filters tiny image candidates.

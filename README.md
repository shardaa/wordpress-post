# WordPress Auto Publisher

This tool researches topics, writes SEO/AEO-rich articles, adds 2-3 relevant images, and creates WordPress posts through the WordPress REST API.

By default it uses Playwright browser automation for research with this priority:

1. Google
2. Bing
3. DuckDuckGo

It still uses AI APIs only for article writing.

## What It Does

For each topic in `topics.txt`:

1. Searches Google, then Bing, then DuckDuckGo in a browser for latest sources.
2. Pulls images from local files first, then from researched page metadata.
3. Uses Gemini or OpenAI to write a structured article.
4. Downloads and uploads 2-3 images to WordPress.
5. Creates a WordPress post as `draft` or `publish`.
6. Saves a local copy in `output/`.
7. Marks the topic as processed in `state/processed.json`.

## Setup

Create your real env file:

```bash
cp wordpress-auto-publisher/.env.example wordpress-auto-publisher/.env
```

Put your keys in:

```bash
wordpress-auto-publisher/.env
```

Do not put real keys in `.env.example`.

Required values:

```bash
AI_PROVIDER=gemini
GEMINI_API_KEY=your_gemini_key

RESEARCH_MODE=browser
SEARCH_ENGINES=google,bing,duckduckgo

WP_BASE_URL=https://your-site.com
WP_USERNAME=your_wordpress_username
WP_APP_PASSWORD=your_wordpress_application_password
WP_POST_STATUS=draft
WP_DEFAULT_CATEGORY_NAME=AI World
```

If you are using browser mode, `GOOGLE_CSE_API_KEY` and `GOOGLE_CSE_ID` are not required.

Browser mode settings:

```bash
RESEARCH_MODE=browser
SEARCH_ENGINES=google,bing,duckduckgo
BROWSER_HEADLESS=true
SEARCH_PAGE_TIMEOUT_MS=20000
SOURCE_PAGE_TIMEOUT_MS=20000
BROWSER_MAX_CANDIDATES=12
```

## WordPress Application Password

In WordPress:

1. Go to `Users -> Profile`.
2. Find `Application Passwords`.
3. Create one named `Auto Publisher`.
4. Copy the generated password into `WP_APP_PASSWORD`.

Use an Application Password, not your normal WordPress login password.

## Default Category

If all posts should go into one WordPress category, set this in `.env`:

```bash
WP_DEFAULT_CATEGORY_NAME=AI World
```

The publisher will look up that category automatically and assign every post to it.

If you prefer numeric IDs, you can still use:

```bash
WP_DEFAULT_CATEGORY_IDS=123
```

## Run

From the project root:

```bash
node wordpress-auto-publisher/scripts/publish_articles.mjs
```

Dry run without WordPress publishing:

```bash
node wordpress-auto-publisher/scripts/publish_articles.mjs --dry-run
```

Force browser research:

```bash
node wordpress-auto-publisher/scripts/publish_articles.mjs --research=browser
```

Use the old Google Custom Search API mode:

```bash
node wordpress-auto-publisher/scripts/publish_articles.mjs --research=api
```

Process only the first pending topic:

```bash
ARTICLE_LIMIT=1 node wordpress-auto-publisher/scripts/publish_articles.mjs
```

Test WordPress credentials before publishing:

```bash
node wordpress-auto-publisher/scripts/test_wordpress_auth.mjs
```

## Web UI

Run the local UI:

```bash
cd "/Users/ashishsharda/Downloads/app development/test/wordpress-auto-publisher"
npm run start
```

Then open:

```text
http://localhost:3000
```

Click `Generate` to process exactly one topic.

## Railway

This app is ready for Railway deployment with Docker and Playwright.

Deploy the `wordpress-auto-publisher` folder as a service and set all env vars from `.env`.

Important Railway envs:

```bash
PORT=3000
ARTICLE_LIMIT=1
BROWSER_HEADLESS=true
```

Use `WP_POST_STATUS=draft` first.

## Going Live

The default is:

```bash
WP_POST_STATUS=draft
```

After reviewing the output quality, change it to:

```bash
WP_POST_STATUS=publish
```

## Notes

- Browser research can hit captchas or blocked pages. If Google is blocked, the script tries Bing, then DuckDuckGo.
- Image licensing still matters. The safest option is to put your own images in `wordpress-auto-publisher/images/`.
- The generated article includes source links from the research results.
- Topics already processed are skipped unless you delete `state/processed.json`.

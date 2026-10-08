# Offline article response fixtures

These are hand-authored, saved JSON responses matching the public Pixiv API
shapes consumed by `scrapeSingleArticleInfo`. They are synthetic regression
fixtures, not captured live responses or claims about the current contents of
any Pixiv article. No live requests, cookies, user identifiers, or credentials
were used to produce them.

- `rich.json` fixes expected output for reading, breadcrumbs, category fallback,
  abstract and first-section text, nested nodes, related-tag deduplication,
  illustration URL, counts, and JST timestamp conversion.
- `minimal.json` covers a headingless article, absent optional fields, zero
  counts, and a tag requiring URL encoding.

The tests replace only `fetchURL`; the real scraper, endpoint construction, and
parser run unchanged. Keep expected output explicit rather than generating it
with parser helpers. When the API shape changes, add a minimized, sanitized
response and regression assertion here before updating the production parser.
The separate live smoke workflow detects upstream behavior that fixed fixtures
cannot detect.

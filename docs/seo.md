# Search setup

What is already in the repo, and the two things that need a human with a login.

## What ships with the site

| File                 | What it does                                                                     |
| -------------------- | -------------------------------------------------------------------------------- |
| `site/robots.txt`    | Opens the whole site to crawlers and names the sitemap.                          |
| `site/sitemap.xml`   | The four pages, at their canonical addresses. Written by `npm run sitemap`.      |
| `site/assets/og.png` | 1200×630 card that X, LinkedIn and Slack unfurl a link into.                     |
| `site/<key>.txt`     | IndexNow key. Proves the deploy's submissions come from whoever owns the domain. |
| `site/llms.txt`      | Plain-text summary and ranking for AI assistants. Written by `npm run static`.   |

Every page carries a `<link rel="canonical">`, a `<meta name="description">`,
and `og:`/`twitter:` tags. The home page also carries a JSON-LD `Dataset` node,
which is what lets the run turn up in [Google Dataset
Search](https://datasetsearch.research.google.com/) rather than only in web
results.

One page, one address: the pages link to `/markets`, the canonical tags claim
`/markets`, and the CloudFront function 301s `/markets.html` and
`www.noisebench.com` onto it. Nothing has to guess which of the two keys in the
bucket is the real page.

## Results in the HTML

The charts draw from `site/data/*.json` in the browser, which crawlers that
skip JavaScript (Bing often, most AI crawlers always) never see.
`npm run static` (`scripts/gen-static.mjs`) writes the same numbers into the
pages between `<!-- static:NAME -->` markers: a one-paragraph answer and the
ranking table on the home page, a Q&A block with matching FAQPage JSON-LD, and
every question as a plain table on `/markets` (the sortable table replaces it
once the script runs). It also writes `llms.txt` and the Dataset's
`dateModified` and `temporalCoverage`. The deploy runs it before every upload,
so the pages cannot go out of step with the data; run it locally to preview.

The author is the Person declared on luisfominaya.com
(`https://luisfominaya.com/#person`), so every project points at one identity.

## "Page with redirect" in Search Console

`http://`, `www.`, `/index.html` and `/compare.html` style addresses show up in
Search Console under "Page with redirect". That is the router doing its job:
each 301s to the one canonical address, and Google is reporting that it will
index the target instead. Nothing to fix, as long as the pages and the
sitemap only ever use the canonical form.

## Google Search Console

Verify by **DNS**, which registers a Domain property covering the apex, `www`,
and any future subdomain in one go.

1. [search.google.com/search-console](https://search.google.com/search-console)
   → **Add property** → **Domain** → `noisebench.com`.
2. Copy the TXT value it shows (`google-site-verification=…`).
3. Put it in `terraform/terraform.tfvars`:

   ```hcl
   site_verification_txt = ["google-site-verification=xxxxxxxxxxxxxxxxxxxx"]
   ```

4. `cd terraform && terraform apply`, wait a minute for the record to publish,
   then press **Verify**.
5. Once verified: **Sitemaps** → submit `sitemap.xml`.

Do **not** use the "HTML file" method. The router redirects `/google<token>.html`
to `/google<token>`, so the verifier never sees the file at the URL it asks for.
The meta-tag method does work if DNS is inconvenient — it goes in
`site/index.html` and only verifies that one origin, so you would add
`https://noisebench.com/` as a URL-prefix property instead.

## Bing Webmaster Tools

The fast path, once Search Console is verified:

1. [bing.com/webmasters](https://www.bing.com/webmasters) → **Import from
   Google Search Console** → sign in → pick the property. Sites, sitemaps and
   verification all come across in one step.

If you would rather not connect the two accounts, verify directly with either:

- **`BingSiteAuth.xml`** — drop the file Bing gives you into `site/` and push.
  Its `.xml` extension means the router leaves it alone.
- **CNAME** — set `bing_verification_cname` in `terraform.tfvars` to the label
  Bing shows, then `terraform apply`:

  ```hcl
  bing_verification_cname = "abc123def456"
  ```

Then submit `https://noisebench.com/sitemap.xml` under **Sitemaps**.

Bing already learns about each deploy through IndexNow — the workflow submits
every sitemap URL after the smoke test passes, and one submission reaches
Yandex, Seznam and Naver too. Registering the key under **IndexNow** in Bing
Webmaster Tools is optional; a key file at the site root is proof enough on its
own.

## Publishing a change

`npm run sitemap` reads the dates out of git, so run it after the data is
regenerated and before you commit:

```bash
npx tsx scripts/analyze.ts --run 1
npm run static
npm run sitemap
git commit -am "…" && git push
```

The deploy fails if a page in `site/` is missing from the sitemap, so a new page
cannot ship unlisted.

## Regenerating the share card

`site/assets/og.png` is a design asset, not a build output — it changes only
when the wordmark or the tagline does. It was drawn with Pillow at 1200×630 in
the site's own light-theme tokens: the logo and wordmark, the tagline, and the
Noise Index chart in miniature in the vendor brand hues. Any tool that produces
an opaque 1200×630 PNG will do; keep the filename so the `og:image` URLs in the
four pages stay valid.

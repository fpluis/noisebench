// Write site/sitemap.xml from the pages in site/.
//
//   npm run sitemap
//
// Run it after `npm run analyze` and before committing — the publish flow in
// the README has it in order.
//
// The URLs are the extensionless form CloudFront serves, which is also what
// every <link rel="canonical"> claims and what the pages link to. Nothing here
// emits <priority> or <changefreq>: Google ignores both, and Bing treats them
// as hints at best, so they would be two more things to keep honest for no
// gain.
//
// lastmod comes from git rather than from file mtimes, which say when the
// working copy was written and survive no checkout. A page's content is its
// markup plus the analysis JSON it reads — all four pages read metrics.json —
// so each URL takes the later of those two dates. Anything already modified in
// the working tree is dated today, since the commit that publishes it is the
// next one.

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const ORIGIN = "https://noisebench.com";
const ROOT = path.resolve("site");
const OUT = path.join(ROOT, "sitemap.xml");

// Served, but never a search result: CloudFront returns it for every unknown
// path and the page itself carries <meta name="robots" content="noindex">.
const EXCLUDED = new Set(["404.html"]);

const git = (args: string[]): string => {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

const today = (): string => new Date().toISOString().slice(0, 10);

// YYYY-MM-DD, which sorts lexicographically and is a legal <lastmod>.
const lastChanged = (pathspec: string): string =>
  git(["status", "--porcelain", "--", pathspec])
    ? today()
    : git(["log", "-1", "--format=%cs", "--", pathspec]) || today();

const main = (): void => {
  if (!fs.existsSync(ROOT)) throw new Error(`no ${ROOT} directory`);

  // A shallow clone knows no history and every lookup falls back to today,
  // which would silently date the whole sitemap wrong.
  if (git(["rev-parse", "--is-shallow-repository"]) === "true") {
    console.warn("⚠️  shallow clone — lastmod dates will all read as today\n");
  }

  const data = lastChanged(path.join(ROOT, "data"));

  const pages = fs
    .readdirSync(ROOT)
    .filter((name) => name.endsWith(".html") && !EXCLUDED.has(name))
    .sort((a, b) =>
      a === "index.html" ? -1 : b === "index.html" ? 1 : a.localeCompare(b),
    );

  const urls = pages.map((name) => {
    const slug = name === "index.html" ? "" : name.replace(/\.html$/, "");
    const changed = lastChanged(path.join(ROOT, name));
    return {
      loc: `${ORIGIN}/${slug}`,
      lastmod: changed > data ? changed : data,
    };
  });

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.flatMap(({ loc, lastmod }) => [
      "  <url>",
      `    <loc>${loc}</loc>`,
      `    <lastmod>${lastmod}</lastmod>`,
      "  </url>",
    ]),
    "</urlset>",
    "",
  ].join("\n");

  fs.writeFileSync(OUT, xml);

  console.log(`${OUT} — ${urls.length} URLs`);
  for (const { loc, lastmod } of urls) console.log(`  ${lastmod}  ${loc}`);
};

main();

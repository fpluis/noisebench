// Serve site/ over HTTP for local viewing.
//
//   npm run site               # http://localhost:4321
//   npm run site -- --port 8080
//
// The pages fetch their JSON from data/, which the file:// origin blocks, so
// the site needs a server even though it is entirely static. Written against
// node:http rather than a dependency so `npm run site` works from a clean
// checkout with nothing installed but the project's own packages.

import fs from "fs";
import http from "http";
import path from "path";
import { parseArgs } from "../src/utils";

const ROOT = path.resolve("site");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const main = (): void => {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port ?? 4321);

  if (!fs.existsSync(path.join(ROOT, "data", "run.json"))) {
    console.warn(
      "⚠️  site/data/run.json is missing — run `npx tsx scripts/analyze.ts --run 1` first.\n",
    );
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const rel =
      decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    // Resolve inside ROOT and reject anything that escapes it.
    const target = path.resolve(ROOT, rel);
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    const file =
      fs.existsSync(target) && fs.statSync(target).isDirectory()
        ? path.join(target, "index.html")
        : target;

    if (!fs.existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }

    res.writeHead(200, {
      "content-type":
        TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      // The analysis JSON is regenerated in place; a cached copy would silently
      // show yesterday's numbers.
      "cache-control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  });

  server.listen(port, () => {
    console.log(`noisebench site → http://localhost:${port}`);
    console.log("Ctrl-C to stop.");
  });
};

main();

/**
 * Local dev server: runs the real Worker fetch handler (worker/index.js) under Node,
 * with a D1-compatible shim backed by node:sqlite and a static file server for public/.
 *
 * Why: wrangler dev's local D1 (workerd sqlite) fails on some Windows machines.
 * Production/deploy uses genuine Cloudflare D1 — this shim only affects local dev.
 *
 * Usage: node dev-server.mjs   (or: npm run dev)
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(root, "public");
const DB_FILE = path.join(root, ".dev", "dev.sqlite");
mkdirSync(path.dirname(DB_FILE), { recursive: true });

/* ------------------------- D1-compatible SQLite shim ----------------------- */
const sqlite = new DatabaseSync(DB_FILE);
sqlite.exec("PRAGMA journal_mode = WAL;");

class D1Statement {
  constructor(sql) { this.sql = sql; this.params = []; }
  bind(...params) { this.params = params; return this; }
  async run() {
    const stmt = sqlite.prepare(this.sql);
    const r = stmt.run(...this.params);
    return { success: true, results: [], meta: { changes: r.changes, last_row_id: r.lastInsertRowid } };
  }
  async first() {
    const stmt = sqlite.prepare(this.sql);
    return stmt.get(...this.params) ?? null;
  }
  async all() {
    const stmt = sqlite.prepare(this.sql);
    return { results: stmt.all(...this.params), success: true, meta: {} };
  }
}
class D1Shim {
  prepare(sql) { return new D1Statement(sql); }
  async batch(statements) {
    const out = [];
    sqlite.exec("BEGIN");
    try {
      for (const s of statements) out.push(await s.run());
      sqlite.exec("COMMIT");
    } catch (e) {
      sqlite.exec("ROLLBACK");
      throw e;
    }
    return out;
  }
  async exec(sql) { sqlite.exec(sql); return { count: 0, duration: 0 }; }
}

/* ------------------------------ static assets ------------------------------ */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};
async function serveStatic(urlPath) {
  let p = path.normalize(path.join(PUBLIC, urlPath === "/" ? "index.html" : urlPath));
  if (!p.startsWith(PUBLIC)) return null;
  if (!existsSync(p)) return null;
  const body = await readFile(p);
  return new Response(body, {
    headers: { "content-type": MIME[path.extname(p)] || "application/octet-stream" },
  });
}

/* ------------------------------ worker handler ----------------------------- */
const worker = (await import("./worker/index.js")).default;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:8787");
  try {
    let response;
    if (url.pathname.startsWith("/api/")) {
      // re-read body for non-GET
      const chunks = [];
      if (req.method !== "GET" && req.method !== "HEAD") {
        for await (const c of req) chunks.push(c);
      }
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      const env = { DB: new D1Shim(), ASSETS: { fetch: serveStatic } };
      response = await worker.fetch(request, env, {});
    } else {
      response = (await serveStatic(url.pathname)) || new Response("Not found", { status: 404 });
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `Server error: ${e.message}` }));
  }
});

server.listen(8787, "127.0.0.1", () => {
  console.log("SocialAudit dev server → http://localhost:8787  (demo mode: no Meta creds needed)");
});

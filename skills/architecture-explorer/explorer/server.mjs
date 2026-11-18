// Architecture explorer server: node server.mjs [--root <repo>] [--port 5190]
// Listens on 127.0.0.1 only (this computer), scans the repository (default: the current folder), watches it for
// changes, and pushes updates to the open page with server-sent events. It only reads the repository.
import http from "node:http";
import { watch, readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, resolve, dirname, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RepoScanner } from "./scanner/index.mjs";
import { normalizeText, maskSecrets } from "./scanner/text.mjs";

const toolDir = dirname(fileURLToPath(import.meta.url));
const argRoot = process.argv.indexOf("--root");
// The full path, never an 8.3 short name (C:\Users\LONGNA~1\...): Windows file watching aborts the process on those.
const root = realpathSync.native(resolve(argRoot > 0 ? process.argv[argRoot + 1] : process.cwd()));
const publicDir = join(toolDir, "public");
const argPort = process.argv.indexOf("--port");
const WANTED_PORT = Number(argPort > 0 ? process.argv[argPort + 1] : process.env.ARCH_EXPLORER_PORT ?? 5190);
let PORT = WANTED_PORT;
const HOST = "127.0.0.1";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let scanner;
let current = null; // { snapshot, json, gz }
let lastError = null;
const clients = new Set();

function publish(snapshot) {
  const json = Buffer.from(JSON.stringify(snapshot));
  current = { snapshot, json, gz: gzipSync(json) };
}

function rescan(reason, { force = false } = {}) {
  try {
    if (force) scanner.cache.clear();
    const before = current?.snapshot.version;
    const { snapshot, changedFiles } = scanner.scan();
    lastError = null;
    if (snapshot.version !== before) {
      publish(snapshot);
      log(`rescan (${reason}): v${snapshot.version}, ${changedFiles.length} file(s) changed, ${snapshot.durationMs} ms`);
      broadcast("update", { version: snapshot.version, changedFiles: changedFiles.slice(0, 50), durationMs: snapshot.durationMs, reason });
    }
  } catch (e) {
    lastError = String(e?.stack ?? e);
    log("scan failed:", e?.message ?? e);
    broadcast("scan-error", { message: String(e?.message ?? e) });
  }
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// ---------- watching ----------
let timer = null;
const pending = new Set();
let pendingGit = false;
function onFsEvent(_event, filename) {
  if (!filename) return;
  const rel = String(filename).split(sep).join("/");
  if (rel === ".git/index" || rel === ".git/HEAD" || rel.startsWith(".git/refs/heads/")) pendingGit = true;
  else if (scanner.relevant(rel)) pending.add(rel);
  else return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const files = [...pending];
    const git = pendingGit;
    pending.clear();
    pendingGit = false;
    // Git status changed without a source file changing: rebuild the links anyway.
    if (git && !files.length) scanner.snapshot = null;
    rescan(files.length ? `${files.length} path(s): ${files.slice(0, 3).join(", ")}` : "git status");
  }, 450);
}

// ---------- http ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function send(res, status, body, type = "application/json; charset=utf-8", extra = {}) {
  res.writeHead(status, { "Content-Type": type, ...SECURITY_HEADERS, ...extra });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj));

/** Only files the scanner indexed can be read, so the page can't be used to read anything else on the computer. */
function indexedFile(file) {
  if (!file || typeof file !== "string" || file.includes("\0")) return null;
  const clean = file.replace(/\\/g, "/");
  if (!scanner.cache.has(clean)) return null;
  const abs = resolve(root, clean);
  if (!abs.startsWith(root + sep)) return null;
  return { clean, abs };
}

function readSource(file) {
  const text = normalizeText(readFileSync(file.abs, "utf8"));
  return /\.json$/i.test(file.clean) || /appsettings/i.test(file.clean) ? maskSecrets(text) : text;
}

const server = http.createServer((req, res) => {
  // Refuse requests that don't come to this exact local address (blocks DNS-rebinding pages).
  const host = req.headers.host ?? "";
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, "Forbidden", "text/plain");
  const url = new URL(req.url, `http://${host}`);

  if (req.method === "GET" && url.pathname === "/api/graph") {
    if (!current) return sendJson(res, 503, { error: lastError ?? "Scanning…" });
    const gz = /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
    return send(res, 200, gz ? current.gz : current.json, "application/json; charset=utf-8", gz ? { "Content-Encoding": "gzip" } : {});
  }
  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", ...SECURITY_HEADERS, Connection: "keep-alive" });
    res.write(`event: hello\ndata: ${JSON.stringify({ version: current?.snapshot.version ?? 0 })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/source") {
    const file = indexedFile(url.searchParams.get("file"));
    if (!file) return sendJson(res, 404, { error: "Not a scanned file." });
    const lines = readSource(file).split("\n");
    const line = Math.max(1, Math.min(lines.length, Number(url.searchParams.get("line")) || 1));
    const context = Math.max(3, Math.min(400, Number(url.searchParams.get("context")) || 14));
    const start = Math.max(1, line - context);
    const end = Math.min(lines.length, line + context);
    return sendJson(res, 200, { file: file.clean, line, start, total: lines.length, lines: lines.slice(start - 1, end), editorPath: resolve(root, file.clean) });
  }
  if (req.method === "GET" && url.pathname === "/api/search") {
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    if (q.length < 2) return sendJson(res, 200, { hits: [] });
    const hits = [];
    for (const [path, entry] of scanner.cache) {
      if (!entry.result || entry.result.kind === "none" || hits.length >= 80) continue;
      const abs = resolve(root, path);
      if (!existsSync(abs) || statSync(abs).size > 2_000_000) continue;
      const lines = readSource({ clean: path, abs }).split("\n");
      for (let i = 0; i < lines.length && hits.length < 80; i++) if (lines[i].toLowerCase().includes(q)) hits.push({ file: path, line: i + 1, text: lines[i].trim().slice(0, 200) });
    }
    return sendJson(res, 200, { hits, truncated: hits.length >= 80 });
  }
  if (req.method === "POST" && url.pathname === "/api/rescan") {
    rescan("manual full rescan", { force: true });
    return sendJson(res, 200, { version: current?.snapshot.version });
  }
  if (req.method === "GET") {
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const abs = resolve(publicDir, rel);
    if (!abs.startsWith(publicDir + sep) || !existsSync(abs) || !statSync(abs).isFile()) return send(res, 404, "Not found", "text/plain");
    return send(res, 200, readFileSync(abs), MIME[extname(abs)] ?? "application/octet-stream");
  }
  send(res, 405, "Method not allowed", "text/plain");
});

log(`scanning ${root} …`);
const argConfig = process.argv.indexOf("--config");
scanner = new RepoScanner(root, { toolDir, configPath: argConfig > 0 ? resolve(process.argv[argConfig + 1]) : null });
rescan("start");
try {
  watch(root, { recursive: true }, onFsEvent);
  log("watching the repository for changes");
} catch (e) {
  log("file watching unavailable:", e.message, "— use the Rescan button");
}
// Use the wanted port, or the next free one (several repositories can be explored at once).
server.on("error", (e) => {
  if (e.code === "EADDRINUSE" && PORT < WANTED_PORT + 20) {
    PORT++;
    server.listen(PORT, HOST);
  } else {
    log(`could not start: ${e.message}`);
    process.exit(1);
  }
});
server.on("listening", () => log(`Architecture explorer: http://${HOST}:${PORT}  (this computer only)`));
server.listen(PORT, HOST);

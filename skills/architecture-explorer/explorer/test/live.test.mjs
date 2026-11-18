// End-to-end: start the real server on a fixture repository, change a file, and expect a pushed update whose
// snapshot contains the new route. Also checks that the server refuses other hosts and unscanned files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { writeFixture } from "./make-fixture.mjs";

const toolDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5199;

function get(path, headers = {}) {
  return new Promise((res, rej) => {
    http.get({ host: "127.0.0.1", port: PORT, path, headers: { Host: `127.0.0.1:${PORT}`, ...headers } }, (r) => {
      let body = "";
      r.on("data", (c) => (body += c));
      r.on("end", () => res({ status: r.statusCode, body }));
    }).on("error", rej);
  });
}

test("the server pushes an update when a file changes", { timeout: 40000 }, async () => {
  const root = writeFixture(mkdtempSync(join(tmpdir(), "arch-live-")));
  const file = join(root, "src/Shop.Api/Program.cs");
  const server = spawn(process.execPath, [join(toolDir, "server.mjs"), "--root", root, "--port", String(PORT)], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  server.stdout.on("data", (d) => (output += d));
  server.stderr.on("data", (d) => (output += d));
  try {
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("server did not start")), 20000);
      server.stdout.on("data", (d) => String(d).includes("this computer only") && (clearTimeout(t), res()));
    });
    const first = JSON.parse((await get("/api/graph")).body);
    assert.ok(first.nodes["endpoint:GET /api/orders"]);

    // Security: another Host header is refused; a file outside the scan can't be read.
    assert.equal((await get("/api/graph", { Host: "evil.example:5199" })).status, 403);
    assert.equal((await get("/api/source?file=../../Windows/win.ini")).status, 404);
    assert.equal((await get("/api/source?file=src/Shop.Api/Program.cs&line=1")).status, 200);

    const update = new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("no update event within 15 s")), 15000);
      http.get({ host: "127.0.0.1", port: PORT, path: "/api/events", headers: { Host: `127.0.0.1:${PORT}` } }, (r) => {
        let buf = "";
        r.on("data", (c) => {
          buf += c;
          if (buf.includes("event: hello") && !buf.includes("changed")) {
            setTimeout(() => writeFileSync(file, `var app = builder.Build();
var api = app.MapGroup("/api");
api.MapGet("/orders", () => 1);
api.MapDelete("/things/{id:guid}", () => 1);
`), 300);
            buf += "changed";
          }
          const m = /event: update\ndata: (.*)\n/.exec(buf);
          if (m) {
            clearTimeout(t);
            r.destroy();
            res(JSON.parse(m[1]));
          }
        });
      });
    });
    const info = await update;
    assert.ok(info.changedFiles.some((c) => c.path.endsWith("Program.cs")));
    const after = JSON.parse((await get("/api/graph")).body);
    assert.ok(after.nodes["endpoint:DELETE /api/things/{id:guid}"], "the new route is in the pushed snapshot");
    assert.ok(after.version > first.version);
  } catch (e) {
    console.log(`server output:\n${output}`);
    throw e;
  } finally {
    server.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

// node cli.mjs [--root <repo>] [--config <file>] [command]
//
//   (no command)        scan once; print the summary, the coverage table and the findings
//   --find <text>       list nodes whose name, path or route contains <text>
//   --node <id|text>    one node's details and every relationship with its evidence (file:line)
//   --json <file>       also save the whole snapshot as JSON
//
// Nothing is written to the repository.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RepoScanner } from "./scanner/index.mjs";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const toolDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(arg("--root") ?? process.cwd());
const scanner = new RepoScanner(root, { toolDir, configPath: arg("--config") ? resolve(arg("--config")) : null });
const { snapshot: s } = scanner.scan();
const nodes = Object.values(s.nodes);
const count = (t) => nodes.filter((n) => n.type === t).length;

const findNodes = (q) => {
  const lq = q.toLowerCase();
  return nodes
    .filter((n) => `${n.id} ${n.label} ${n.file ?? ""} ${n.data?.route ?? ""}`.toLowerCase().includes(lq))
    .sort((a, b) => (a.label.toLowerCase() === lq ? -1 : 0) - (b.label.toLowerCase() === lq ? -1 : 0) || a.label.length - b.label.length);
};

if (arg("--find")) {
  for (const n of findNodes(arg("--find")).slice(0, 60)) console.log(`${n.type.padEnd(11)} ${n.id}${n.file ? `   (${n.file}${n.line ? `:${n.line}` : ""})` : ""}`);
} else if (arg("--node")) {
  const q = arg("--node");
  const n = s.nodes[q] ?? findNodes(q)[0];
  if (!n) {
    console.log(`No node matches "${q}". Try --find.`);
    process.exit(1);
  }
  console.log(`${n.type}: ${n.label}\nid: ${n.id}${n.file ? `\nsource: ${n.file}:${n.line ?? 1}` : ""}${n.desc ? `\n${n.desc}` : ""}`);
  if (n.type === "endpoint") {
    const a = n.data.auth;
    console.log(`\nWho may call it: ${a.level}`);
    for (const g of a.routeAuth ?? []) console.log(`  route  ${g.kind}${g.name ? ` ${g.name}` : ""}   ${g.file}:${g.line}  ${g.note ?? ""}`);
    for (const r of a.handlerRequires ?? []) console.log(`  code   requires ${r.permission ?? "(computed)"}   ${r.file}:${r.line}  via ${r.via}${r.inferred ? " (inferred)" : ""}`);
    for (const r of a.handlerAllows ?? []) console.log(`  code   branches on ${r.permission ?? r.role ?? r.policy ?? "?"}   ${r.file}:${r.line}  via ${r.via}${r.inferred ? " (inferred)" : ""}`);
    if (a.fallback) console.log(`  fallback policy   ${a.fallback.file}:${a.fallback.line}`);
    if (n.data.handler) console.log(`Handler: ${n.data.handler.name ?? n.data.handler.kind} ${n.data.handler.file ?? ""}:${n.data.handler.line ?? ""}`);
  }
  const show = (list, dir) => {
    for (const e of list) {
      const other = s.nodes[dir === "out" ? e.to : e.from];
      const ev = e.evidence[0];
      console.log(`  [${e.status}] ${dir === "out" ? "→" : "←"} ${e.kind} ${other?.label ?? (dir === "out" ? e.to : e.from)}${ev ? `   ${ev.file}:${ev.line}  ${ev.note ?? ""}` : ""}`);
    }
  };
  const outs = s.edges.filter((e) => e.from === n.id);
  const ins = s.edges.filter((e) => e.to === n.id);
  console.log(`\nUses (${outs.length}):`);
  show(outs.slice(0, 80), "out");
  console.log(`\nUsed by (${ins.length}):`);
  show(ins.slice(0, 80), "in");
  const kids = nodes.filter((k) => k.parent === n.id);
  if (kids.length) console.log(`\nContains (${kids.length}): ${kids.slice(0, 40).map((k) => k.label).join(", ")}${kids.length > 40 ? ", …" : ""}`);
} else {
  console.log(`${s.title} — scanned ${s.meta.files} files in ${s.durationMs} ms (TypeScript parser ${s.meta.typescript ?? "not found"}, branch ${s.git.branch ?? "?"})`);
  console.log(`Config: ${s.config.source ?? "none (auto-detected)"}${s.config.error ? `  ERROR: ${s.config.error}` : ""}`);
  console.log(`Projects: ${s.layout.projects.map((p) => `${p.name} (${p.layer})`).join(", ") || "none"} · Frontend: ${s.layout.frontendRoots.map((r) => r || ".").join(", ") || "none"} · Migrations: ${s.layout.migrationDirs.join(", ") || "none"}`);
  console.log(`Nodes: ${nodes.length} (${count("endpoint")} endpoints, ${count("table")} tables, ${count("screen")} screens, ${count("permission")} permissions/policies, ${count("type")} C# types)`);
  console.log(`Edges: ${s.edges.length} — verified ${s.coverage.edges.verified}, inferred ${s.coverage.edges.inferred}, unresolved ${s.coverage.edges.unresolved}\n`);
  console.log("Coverage (raw matches vs what was understood):");
  for (const r of s.coverage.rows) console.log(`  ${r.area.padEnd(62)} raw ${String(r.raw).padStart(5)}  matched ${String(r.matched).padStart(5)}  left ${String(r.left).padStart(4)}\n      ${r.detail}`);
  if (s.coverage.crossChecks.length) console.log("\nCross-checks:");
  for (const c of s.coverage.crossChecks) console.log(`  ${c.name}: ${c.agree ? "agrees" : "DISAGREES"} (${c.rows.map((r) => `${r.permission} ${r.expected}/${r.scanned}`).join(", ")})`);
  console.log("\nFindings:");
  for (const f of s.findings) {
    console.log(`  [${f.severity}] ${f.title} (${f.evidence.length})`);
    for (const e of f.evidence.slice(0, 5)) console.log(`        ${e.file}:${e.line}  ${e.note ?? ""}`);
  }
}
const out = arg("--json");
if (out) writeFileSync(out, JSON.stringify(s));

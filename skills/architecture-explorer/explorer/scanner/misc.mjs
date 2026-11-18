// Markdown docs, JSON config and project files.
import { lineIndex } from "./text.mjs";

const CODE_PATH = /(?<![\w/.:-])((?:\.\/)?[\w.-]+\/[\w./\-[\]]*\.(?:cs|tsx?|jsx?|mjs|sql|md|json|csproj|ya?ml))(?![\w/])/g;
const CODE_NAME = /`([A-Z][A-Za-z0-9]+\.(?:cs|tsx?))`/g;

export function scanMarkdown(text, path) {
  const lineOf = lineIndex(text);
  const headings = [];
  for (const m of text.matchAll(/^(#{1,4})\s+(.+)$/gm)) headings.push({ level: m[1].length, text: m[2].trim(), line: lineOf(m.index) });
  const mentions = [];
  for (const m of text.matchAll(CODE_PATH)) mentions.push({ target: m[1].replace(/[.,;:)]+$/, ""), line: lineOf(m.index), kind: "path" });
  for (const m of text.matchAll(CODE_NAME)) mentions.push({ target: m[1], line: lineOf(m.index), kind: "file name" });
  // Process steps, either a table   | 1 | **Name**: detail | Who |   (or | 1 | Name | detail | Who |)
  // or a numbered list               1. **Name** — detail
  const steps = [];
  for (const m of text.matchAll(/^\|\s*(\d{1,2})\.?\s*\|([^\n]*)$/gm)) {
    const cells = m[2].split("|").map((c) => c.trim()).filter((c, i, a) => i < a.length - 1 || c);
    if (!cells.length) continue;
    const bold = /^\*\*([^*]+)\*\*:?\s*(.*)$/.exec(cells[0]);
    const name = (bold ? bold[1] : cells[0]).replace(/:$/, "").trim();
    const detail = bold ? bold[2] || (cells.length > 2 ? cells[1] : "") : cells.length > 2 ? cells[1] : "";
    const who = cells.length > 1 ? cells[cells.length - 1] : "";
    if (name) steps.push({ number: Number(m[1]), name, detail: detail.replace(/\*\*/g, ""), who: who === detail ? "" : who.replace(/\*\*/g, ""), line: lineOf(m.index) });
  }
  if (!steps.length) {
    for (const m of text.matchAll(/^\s{0,3}(\d{1,2})[.)]\s+\*\*([^*]+)\*\*\s*[:—–-]?\s*(.*)$/gm)) {
      steps.push({ number: Number(m[1]), name: m[2].trim(), detail: m[3].trim(), who: "", line: lineOf(m.index) });
    }
  }
  const firstPara = text.split("\n").find((l) => l.trim() && !l.startsWith("#") && !l.startsWith("|") && !l.startsWith("@"));
  return {
    kind: "markdown",
    title: headings[0]?.text ?? path.split("/").pop(),
    headings: headings.slice(0, 80),
    mentions,
    steps,
    summary: firstPara ? firstPara.trim().slice(0, 400) : null,
    lines: text.split("\n").length,
  };
}

const SECRET_KEY = /(password|passwd|secret|apikey|api_key|token|privatekey|connectionstring)/i;

export function scanJson(text, path) {
  const lineOf = lineIndex(text);
  let data = null;
  let error = null;
  try {
    data = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
  } catch (e) {
    error = String(e.message).slice(0, 160);
  }
  const secrets = [];
  const keys = [];
  const walkKeys = (obj, prefix) => {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}:${k}` : k;
      keys.push(key);
      if (typeof v === "string" && v.trim() && SECRET_KEY.test(k)) {
        const at = text.indexOf(`"${k}"`);
        secrets.push({ key, line: at >= 0 ? lineOf(at) : 1, hasPassword: /password\s*=/i.test(v) || /password/i.test(k) });
      } else if (typeof v === "string" && /password\s*=\s*[^;]+/i.test(v)) {
        const at = text.indexOf(`"${k}"`);
        secrets.push({ key, line: at >= 0 ? lineOf(at) : 1, hasPassword: true });
      }
      if (v && typeof v === "object" && !Array.isArray(v)) walkKeys(v, key);
    }
  };
  if (data) walkKeys(data, "");
  const out = { kind: "json", error, keys: keys.slice(0, 200), secrets, lines: text.split("\n").length };
  if (data && path.endsWith("package.json")) {
    out.packages = [
      ...Object.entries(data.dependencies ?? {}).map(([name, version]) => ({ name, version, dev: false })),
      ...Object.entries(data.devDependencies ?? {}).map(([name, version]) => ({ name, version, dev: true })),
    ].map((p) => ({ ...p, line: lineOf(Math.max(0, text.indexOf(`"${p.name}"`))) }));
    out.scripts = data.scripts ?? {};
  }
  if (data && /launch(Settings)?\.json$/.test(path)) {
    const urls = new Set();
    JSON.stringify(data).replace(/https?:\/\/[^"; ]+/g, (u) => urls.add(u));
    for (const c of data.configurations ?? []) if (c.port) urls.add(`http://localhost:${c.port} (${c.name})`);
    out.urls = [...urls];
  }
  return out;
}

export function scanProject(text, path) {
  const lineOf = lineIndex(text);
  const projectRefs = [];
  const packages = [];
  for (const m of text.matchAll(/<ProjectReference\s+Include="([^"]+)"/g)) projectRefs.push({ include: m[1].replace(/\\/g, "/"), line: lineOf(m.index) });
  for (const m of text.matchAll(/<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/g)) packages.push({ name: m[1], version: m[2] ?? null, line: lineOf(m.index) });
  const projects = [...text.matchAll(/<Project\s+Path="([^"]+)"/g)].map((m) => ({ path: m[1], line: lineOf(m.index) }));
  const sdk = (/<Project\s+Sdk="([^"]+)"/.exec(text) ?? [])[1] ?? null;
  const props = {};
  for (const m of text.matchAll(/<(TargetFramework|Nullable|TreatWarningsAsErrors|UserSecretsId|RootNamespace)>([^<]+)</g)) props[m[1]] = m[2];
  return { kind: "project", sdk, projectRefs, packages, projects, props, lines: text.split("\n").length };
}

/** Practice / data scripts in db/: what tables they touch. */
export function scanSqlScript(text) {
  const tables = new Set();
  for (const m of text.toLowerCase().matchAll(/\b(?:from|into|update|delete\s+from|truncate)\s+([a-z_][a-z0-9_]*)/g)) tables.add(m[1]);
  return { kind: "sql", tables: [...tables], lines: text.split("\n").length };
}

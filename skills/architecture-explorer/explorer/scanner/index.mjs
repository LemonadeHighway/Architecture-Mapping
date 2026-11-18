// Scans a repository into a snapshot the browser can draw. Each file's facts are cached by size and modified time,
// so after a change only the changed files are read again; linking (cheap) is redone every time so the map never
// mixes old and new relationships. A change to the config file clears the cache, since it changes how files are read.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename, relative, sep } from "node:path";
import { walk, createClassifier, makeIgnore } from "./files.mjs";
import { loadConfig, CONFIG_FILE } from "./config.mjs";
import { normalizeText } from "./text.mjs";
import { scanCSharp } from "./csharp.mjs";
import { scanTypeScript, loadTypeScript, typescriptInfo } from "./typescript.mjs";
import { scanMigration } from "./sql.mjs";
import { scanMarkdown, scanJson, scanProject, scanSqlScript } from "./misc.mjs";
import { buildGraph } from "./graph.mjs";
import { computeHealth } from "./health.mjs";

export class RepoScanner {
  /** toolDir: this explorer's folder (skipped if it sits inside the repo; its node_modules is a last-resort parser). */
  constructor(root, { toolDir, configPath = null } = {}) {
    this.root = root;
    this.configPath = configPath;
    this.toolDir = toolDir;
    this.cache = new Map();
    this.version = 0;
    this.snapshot = null;
    this.configKey = null;
    const rel = toolDir ? relative(root, toolDir).split(sep).join("/") : "";
    this.selfPrefix = rel && !rel.startsWith("..") ? rel : null;
    this.refreshConfig();
  }

  refreshConfig() {
    const { config, source, error } = loadConfig(this.root, this.configPath);
    const key = JSON.stringify(config);
    if (key !== this.configKey) {
      this.cache.clear();
      this.snapshot = null;
    }
    this.configKey = key;
    this.config = config;
    this.configSource = source;
    this.configError = error;
    this.isIgnored = makeIgnore([...(config.ignore ?? []), ...(this.selfPrefix ? [this.selfPrefix] : [])]);
  }

  /** True when a changed path could affect the map. */
  relevant(repoPath) {
    return repoPath === CONFIG_FILE || !this.isIgnored(repoPath);
  }

  /** Walks the repo, re-reads changed files, relinks. Returns { snapshot, changedFiles }. */
  scan() {
    const started = Date.now();
    this.refreshConfig();
    const config = this.config;
    const files = walk(this.root, this.isIgnored);
    const layout = createClassifier(this.root, files, config);
    if (!this.tsChecked) {
      loadTypeScript([...layout.frontendRoots.map((r) => join(this.root, r)), this.root, this.toolDir].filter(Boolean));
      this.tsChecked = true;
    }
    const seen = new Set();
    const changedFiles = [];
    const scanErrors = [];
    for (const f of files) {
      f.cls = layout.classify(f.path);
      seen.add(f.path);
      const cached = this.cache.get(f.path);
      if (cached && cached.mtimeMs === f.mtimeMs && cached.size === f.size && cached.scanner === f.cls.scanner) continue;
      changedFiles.push({ path: f.path, change: cached ? "modified" : "added" });
      this.cache.set(f.path, { mtimeMs: f.mtimeMs, size: f.size, scanner: f.cls.scanner, ...this.scanFile(f) });
    }
    for (const p of [...this.cache.keys()]) {
      if (!seen.has(p)) {
        this.cache.delete(p);
        changedFiles.push({ path: p, change: "deleted" });
      }
    }
    const results = new Map();
    for (const f of files) {
      const c = this.cache.get(f.path);
      if (c.result) results.set(f.path, c.result);
      if (c.error) scanErrors.push({ path: f.path, error: c.error });
      if (c.result?.kind === "none" && c.result.reason) f.cls = { ...f.cls, scanner: null, reason: c.result.reason };
    }
    if (this.snapshot && changedFiles.length === 0) return { snapshot: this.snapshot, changedFiles };

    const git = readGit(this.root, this.isIgnored);
    const graph = buildGraph({ files, results, git, config, layout, scanErrors });
    const { findings, coverage } = computeHealth({ graph, files, results, scanErrors, gitInfo: git, config: { ...config, source: this.configSource, error: this.configError } });
    const about = describeRepo(results, config, this.root);
    this.version++;
    this.snapshot = {
      version: this.version,
      scannedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      repoName: basename(this.root),
      title: about.title,
      description: about.description,
      descriptionSource: about.source,
      meta: { node: process.version, typescript: typescriptInfo()?.version ?? null, files: files.length },
      config: { source: this.configSource, error: this.configError, permissionEnum: config.backend?.permissionEnum ?? null, workflow: !!config.workflow },
      layout: { projects: layout.projects.map((p) => ({ dir: p.dir, name: p.name, layer: p.layer })), frontendRoots: layout.frontendRoots, migrationDirs: layout.migrationDirs },
      git,
      nodes: graph.nodes,
      edges: graph.edges,
      areas: graph.areas,
      findings,
      coverage,
      callStats: graph.callStats,
      statusEnums: graph.statusEnums,
      workflow: graph.workflow,
      fallback: graph.fallback,
      defaultsInfo: graph.defaultsInfo,
      schema: { dropped: graph.schemaInfo.dropped, functions: graph.schemaInfo.functions, counts: graph.schemaInfo.counts },
      lastChanges: this.version === 1 ? [] : changedFiles,
    };
    return { snapshot: this.snapshot, changedFiles };
  }

  scanFile(f) {
    const c = this.config;
    let fn = null;
    let opts = undefined;
    switch (f.cls.scanner) {
      case "csharp":
        fn = scanCSharp;
        opts = c.backend;
        break;
      case "typescript":
        if (!typescriptInfo()) return { result: { kind: "none", lines: null, reason: "TypeScript parser not found (install the frontend's packages, e.g. npm install, or set TYPESCRIPT_PATH)" } };
        fn = scanTypeScript;
        opts = {
          ...c.frontend,
          permissionType: c.backend?.permissionEnum ?? null,
          screenFile: (c.frontend?.screenFiles ?? []).some((s) => f.path.endsWith(s)),
        };
        break;
      case "migration":
        fn = scanMigration;
        break;
      case "sql":
        fn = scanSqlScript;
        break;
      case "markdown":
        fn = scanMarkdown;
        break;
      case "json":
        fn = scanJson;
        break;
      case "project":
        fn = scanProject;
        break;
      default:
        return { result: { kind: "none", lines: null } };
    }
    try {
      if (f.size > 3_000_000) return { result: { kind: "none", lines: null, reason: "file larger than 3 MB" } };
      const text = normalizeText(readFileSync(join(this.root, f.path), "utf8"));
      return { result: fn(text, f.path, opts) };
    } catch (e) {
      return { result: null, error: String(e?.message ?? e).slice(0, 300) };
    }
  }
}

/** The map's title and summary: the config, else README.md / CLAUDE.md, else the folder name. */
function describeRepo(results, config, root) {
  const readme = ["README.md", "readme.md", "Readme.md"].map((p) => [p, results.get(p)]).find(([, r]) => r);
  const claude = results.get("CLAUDE.md");
  const doc = readme ?? (claude ? ["CLAUDE.md", claude] : null);
  return {
    title: config.name ?? (readme?.[1]?.headings?.[0]?.text?.replace(/[`*_]/g, "") || basename(root)),
    description: config.description ?? doc?.[1]?.summary ?? null,
    source: config.description ? CONFIG_FILE : doc ? doc[0] : null,
  };
}

/** Branch and uncommitted changes (read only; the explorer never runs a git command that writes). */
export function readGit(root, isIgnored = () => false) {
  const run = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  try {
    const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    let lastCommit = null;
    try {
      lastCommit = run(["log", "-1", "--format=%h %s"]).trim();
    } catch {
      /* a repository with no commits yet */
    }
    const changed = [];
    for (const line of run(["status", "--porcelain=v1", "-uall"]).split("\n")) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2);
      let path = line.slice(3).trim().replace(/^"|"$/g, "");
      if (path.includes(" -> ")) path = path.split(" -> ")[1];
      if (isIgnored(path)) continue;
      const status = code === "??" ? "new" : code.includes("D") ? "deleted" : code.includes("A") ? "added" : code.includes("R") ? "renamed" : "modified";
      changed.push({ path, status });
    }
    return { branch, lastCommit, changed };
  } catch {
    return { branch: null, lastCommit: null, changed: [], error: "not a git repository, or git is not installed" };
  }
}

export { existsSync };

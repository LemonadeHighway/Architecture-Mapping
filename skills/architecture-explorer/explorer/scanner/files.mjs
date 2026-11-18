// Walks the repository and classifies every file: which part of the system it belongs to (layer), which module,
// and which scanner reads it. Projects and frontend apps are detected, not assumed: a .csproj folder is a C#
// project (its layer comes from its name or the config), a package.json with a UI framework is a frontend app.
// Files no scanner reads are still listed, as "not analyzed", so coverage stays honest.
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, sep, posix } from "node:path";

export const IGNORED_DIRS = new Set([
  ".git", "node_modules", "bin", "obj", "dist", "build", "out", "TestResults", "test-results", "playwright-report",
  ".vs", ".idea", ".vscode", "worktrees", ".vite", "coverage", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache",
  "vendor", "__pycache__", ".venv", "venv", "target",
]);

export function toRepoPath(root, abs) {
  return relative(root, abs).split(sep).join("/");
}

export function makeIgnore(extra = []) {
  return (repoPath) => {
    if (extra.some((p) => repoPath === p.replace(/\/$/, "") || repoPath.startsWith(p.endsWith("/") ? p : `${p}/`))) return true;
    return repoPath.split("/").some((part) => IGNORED_DIRS.has(part));
  };
}

export function walk(root, isIgnored) {
  const files = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = toRepoPath(root, abs);
      if (isIgnored(rel)) continue;
      if (e.isDirectory()) visit(abs);
      else if (e.isFile()) {
        const st = statSync(abs);
        files.push({ path: rel, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };
  visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

const UI_PACKAGES = ["react", "react-dom", "next", "vue", "nuxt", "svelte", "@sveltejs/kit", "@angular/core", "solid-js", "preact", "@remix-run/react"];

const LAYER_BY_NAME = [
  [/(^|\.)(tests?|specs?|unittests?|integrationtests?|e2e)$/i, "tests"],
  [/(^|\.)(infrastructure|infra|data|dataaccess|persistence|repositories|repository|storage|db|database)$/i, "infrastructure"],
  [/(^|\.)(domain|core|model|models|entities|application|contracts|shared|common|abstractions|logic|business)$/i, "domain"],
  [/(^|\.)(api|webapi|web|server|host|gateway|functions|service|services|backend|app)$/i, "api"],
];

/** Finds C# projects, frontend apps and migration folders, then returns classify(path). */
export function createClassifier(root, files, config) {
  const read = (p) => {
    try {
      return readFileSync(join(root, p), "utf8");
    } catch {
      return "";
    }
  };
  const layerOverride = (path) => {
    let best = null;
    for (const [prefix, layer] of Object.entries(config.layers ?? {})) {
      const pre = prefix.replace(/\/$/, "");
      if ((path === pre || path.startsWith(`${pre}/`)) && (!best || pre.length > best.pre.length)) best = { pre, layer };
    }
    return best?.layer ?? null;
  };

  // C# projects: the folder of each .csproj.
  const projects = files
    .filter((f) => f.path.endsWith(".csproj"))
    .map((f) => {
      const dir = posix.dirname(f.path) === "." ? "" : posix.dirname(f.path);
      const name = f.path.split("/").pop().replace(/\.csproj$/, "");
      const text = read(f.path);
      const sdkWeb = /Sdk="Microsoft\.NET\.Sdk\.Web"/.test(text);
      const isTest = /Microsoft\.NET\.Test\.Sdk|MSTest|xunit|NUnit/i.test(text);
      const short = name.split(".").pop();
      let layer = layerOverride(dir) ?? (isTest ? "tests" : null);
      if (!layer) for (const [re, l] of LAYER_BY_NAME) if (re.test(short) || re.test(name)) { layer = l; break; }
      if (!layer) layer = sdkWeb ? "api" : "domain";
      return { dir, name, short, layer, testOf: null };
    })
    .sort((a, b) => b.dir.length - a.dir.length);
  for (const p of projects.filter((x) => x.layer === "tests")) {
    const base = p.name.replace(/\.(Unit|Integration)?Tests?$/i, "");
    p.testOf = projects.find((q) => q !== p && q.name === base)?.layer ?? null;
  }
  const perLayer = {};
  for (const p of projects) perLayer[p.layer] = (perLayer[p.layer] ?? 0) + 1;

  // Frontend apps.
  let frontendRoots = config.frontend?.roots;
  if (!frontendRoots) {
    frontendRoots = files
      .filter((f) => f.path.endsWith("package.json"))
      .filter((f) => {
        try {
          const pkg = JSON.parse(read(f.path));
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          return UI_PACKAGES.some((u) => deps[u]);
        } catch {
          return false;
        }
      })
      .map((f) => (posix.dirname(f.path) === "." ? "" : posix.dirname(f.path)));
  }
  frontendRoots = [...new Set(frontendRoots.map((r) => r.replace(/\/$/, "")))].sort((a, b) => b.length - a.length);
  const aliases = [];
  for (const r of frontendRoots) {
    for (const ts of ["tsconfig.json", "tsconfig.app.json", "jsconfig.json"]) {
      const text = read(r ? `${r}/${ts}` : ts);
      if (!text) continue;
      try {
        const json = JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1").replace(/,\s*([}\]])/g, "$1"));
        const base = json.compilerOptions?.baseUrl ?? ".";
        for (const [k, v] of Object.entries(json.compilerOptions?.paths ?? {})) {
          const target = String(v?.[0] ?? "").replace(/\*$/, "");
          aliases.push({ prefix: k.replace(/\*$/, ""), target: posix.normalize(posix.join(r, base, target)).replace(/^\.\//, "") });
        }
      } catch {
        /* a tsconfig we can't parse: no aliases from it */
      }
    }
    if (!aliases.some((a) => a.prefix === "@/" && a.target.startsWith(r))) aliases.push({ prefix: "@/", target: `${r ? `${r}/` : ""}src/`, assumed: true });
  }

  // Migration folders.
  const migrationDirs = config.database?.migrations
    ? config.database.migrations.map((d) => d.replace(/\/$/, ""))
    : [...new Set(files.filter((f) => /(^|\/)migrations\/[^/]+\.sql$/i.test(f.path)).map((f) => posix.dirname(f.path)))];

  const isJsTest = (p) => /\.(test|spec)\.[jt]sx?$/.test(p) || /(^|\/)(e2e|__tests__|tests?)\//.test(p);

  function classify(path) {
    const ext = (/\.([a-z0-9]+)$/i.exec(path) ?? [])[1]?.toLowerCase() ?? "";
    const override = layerOverride(path);
    if (ext === "cs") {
      const proj = projects.find((p) => p.dir === "" || path.startsWith(`${p.dir}/`));
      const layer = override ?? proj?.layer ?? "domain";
      const rest = (proj?.dir ? path.slice(proj.dir.length + 1) : path).split("/");
      let feature = "(root)";
      let sub = null;
      if (/^features$|^modules$|^endpoints$|^slices$/i.test(rest[0]) && rest.length > 2) {
        feature = rest[1];
        sub = rest.length > 3 ? rest[2] : null;
      } else if (rest.length > 1) feature = rest[0];
      const projKey = proj && perLayer[proj.layer] > 1 ? `${proj.short}/` : "";
      if (layer === "tests") {
        const tested = proj?.testOf ?? "app";
        return { scanner: "csharp", layer: "tests", module: `tests/${projKey}${feature}`, moduleLabel: `${proj?.short ?? "Tests"} · ${feature}`, feature, testOf: tested, project: proj?.name };
      }
      return { scanner: "csharp", layer, module: `${layer}/${projKey}${feature}`, moduleLabel: feature === "(root)" ? `${proj?.short ?? "Project"} (root)` : feature, feature, subFeature: sub, project: proj?.name };
    }
    if (/\.(csproj|slnx?|props|targets|fsproj)$/i.test(path)) return { scanner: "project", layer: "config", module: "config/projects", moduleLabel: "Projects and build" };
    if (/^(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/.test(ext)) {
      const fr = frontendRoots.find((r) => r === "" || path.startsWith(`${r}/`));
      const scanner = /^(ts|tsx|js|jsx|mjs|cjs)$/.test(ext) ? "typescript" : null;
      if (fr !== undefined) {
        const inside = fr ? path.slice(fr.length + 1) : path;
        if (!inside.includes("/")) return { scanner, layer: "config", module: `config/${fr || "frontend"}`, moduleLabel: "Frontend build config", reason: scanner ? undefined : "no scanner for this file type" };
        if (override === "tests" || isJsTest(inside)) return { scanner, layer: "tests", module: `tests/frontend`, moduleLabel: "Frontend tests", feature: "frontend", testOf: "web" };
        const parts = inside.replace(/^src\//, "").split("/");
        let key;
        let label;
        if (parts.length > 2 && /^(features|modules|domains|pages|views|routes|app|screens)$/.test(parts[0])) {
          key = `${parts[0]}/${parts[1]}`;
          label = parts[1];
        } else if (parts.length > 1) {
          key = parts[0];
          label = parts[0];
        } else {
          key = "(root)";
          label = "entry";
        }
        const prefix = frontendRoots.length > 1 ? `${fr || "app"}/` : "";
        return { scanner, layer: override ?? "web", module: `web/${prefix}${key}`, moduleLabel: label, feature: label, reason: scanner ? undefined : "no scanner for this file type" };
      }
      if (override) return { scanner, layer: override, module: `${override}/scripts`, moduleLabel: "Scripts" };
      return { scanner: null, layer: "other", module: "other", moduleLabel: "Other files", reason: "script outside the frontend app" };
    }
    if (ext === "sql") {
      if (migrationDirs.some((d) => posix.dirname(path) === d)) return { scanner: "migration", layer: "database", module: "database/migrations", moduleLabel: "Migrations" };
      return { scanner: "sql", layer: "database", module: "database/scripts", moduleLabel: "SQL scripts" };
    }
    if (ext === "md" || ext === "mdx") {
      const parts = path.split("/");
      const mod = parts.length > 2 && /^docs?$/i.test(parts[0]) ? `docs/${parts[1]}` : parts.length > 1 && /^docs?$/i.test(parts[0]) ? "docs/(general)" : "docs/(root)";
      return { scanner: "markdown", layer: "docs", module: mod, moduleLabel: mod.replace("docs/", "") };
    }
    if (ext === "json") {
      if (/package-lock\.json$|\.lock\.json$/.test(path)) return { scanner: null, layer: "config", module: "config/lockfiles", moduleLabel: "Lock files", reason: "lock file" };
      return { scanner: "json", layer: "config", module: "config/settings", moduleLabel: "Settings and manifests" };
    }
    const reason = /^(pdf|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|zip|exe|dll)$/.test(ext) ? "binary or image" : "no scanner for this file type";
    return { scanner: null, layer: override ?? "other", module: "other", moduleLabel: "Other files", reason };
  }

  return { classify, projects, frontendRoots, aliases, migrationDirs };
}

// Project settings. Everything is optional: the explorer auto-detects C# projects, frontend apps, migrations and the
// common ASP.NET Core / React conventions. A project can add its own conventions in `.architecture-explorer.json` at
// the repository root (see references/configuration.md in the skill).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_FILE = ".architecture-explorer.json";

export const DEFAULTS = {
  name: null, // shown as the map's title; default: README title or the folder name
  description: null, // default: first paragraph of README.md (or CLAUDE.md)
  ignore: [], // extra folders or files to skip, repo-relative prefixes
  layers: {}, // "path/prefix": "api" | "infrastructure" | "domain" | "web" | "tests" | "docs" | "config"
  backend: {
    // A C# enum whose members are the app's permissions (e.g. "Permission"). Unset: permissions come only from
    // authorization policies and roles ([Authorize], RequireAuthorization, AddPolicy).
    permissionEnum: null,
    // A C# enum of user roles (e.g. "UserRole"), used for "default permissions per role" if a
    // Dictionary<PermissionEnum, RoleEnum[]> exists.
    roleEnum: null,
    // Extension methods that guard a route with a permission: api.MapGet(...).Requires(Permission.X)
    routeGuards: [],
    // Calls that enforce a permission inside handlers or business rules (throw / refuse without it).
    requireChecks: [],
    // Calls that test a permission and branch on it.
    allowsChecks: [],
  },
  frontend: {
    roots: null, // folders with the frontend app(s); default: every folder with a package.json that has a UI framework
    // Function name -> HTTP verb, in addition to the built-in fetch/axios/api*/http* names.
    apiFunctions: {},
    // Objects whose .get/.post/.put/.patch/.delete(url) are HTTP calls.
    apiClients: ["axios", "api", "http", "client", "apiClient", "httpClient", "request", "$http", "ky"],
    // Functions whose string argument names a permission the screen checks, e.g. useCan("EditOrders").
    permissionChecks: [],
    // Files whose `switch` cases render a page component are treated as screen routers (besides React Router).
    screenFiles: ["Shell.tsx", "Router.tsx", "Routes.tsx", "App.tsx"],
  },
  database: {
    migrations: null, // folders with .sql migrations, applied in file-name order; default: any folder named migrations
  },
  workflow: null, // { "source": "docs/process.md", "steps": [{ "number": 1, "keywords": ["lead"] }] }
};

function merge(base, extra) {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return extra ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = base && typeof base[k] === "object" && !Array.isArray(base[k]) && base[k] !== null ? merge(base[k], v) : v;
  }
  return out;
}

/** Reads the project's config (or the file given with --config). Returns { config, source, error }. */
export function loadConfig(root, explicitPath = null) {
  const path = explicitPath ?? join(root, CONFIG_FILE);
  if (explicitPath && !existsSync(path)) return { config: DEFAULTS, source: explicitPath, error: `Config file not found: ${explicitPath}` };
  if (!existsSync(path)) return { config: DEFAULTS, source: null, error: null };
  try {
    const raw = readFileSync(path, "utf8").replace(/^﻿/, "");
    return { config: merge(DEFAULTS, JSON.parse(raw)), source: explicitPath ?? CONFIG_FILE, error: null };
  } catch (e) {
    return { config: DEFAULTS, source: explicitPath ?? CONFIG_FILE, error: `Couldn't read ${explicitPath ?? CONFIG_FILE}: ${e.message}` };
  }
}

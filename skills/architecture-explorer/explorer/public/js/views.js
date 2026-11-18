// Every view is a projection of the same graph: it picks which nodes to draw (and in which column), and the edges
// between them are the leaf relationships lifted up to those nodes (model.liftEdges). Nothing here invents a link.
import { edgeFilter, liftEdges, TYPE_LABEL } from "./model.js";

export const VIEWS = [
  { id: "overview", label: "Overview", icon: "system" },
  { id: "architecture", label: "Software architecture", icon: "api" },
  { id: "modules", label: "Functional modules", icon: "area" },
  { id: "structure", label: "Code structure", icon: "dir" },
  { id: "dependencies", label: "Module dependencies", icon: "module" },
  { id: "frontend", label: "Frontend ↔ backend", icon: "web" },
  { id: "api", label: "API connections", icon: "endpoint" },
  { id: "database", label: "Database", icon: "database" },
  { id: "workflow", label: "Business workflow", icon: "workflow" },
  { id: "security", label: "Security & permissions", icon: "security" },
  { id: "integrations", label: "External integrations", icon: "external" },
];

/** Synthetic groupings that aren't folders: functional areas and route groups. */
export function deriveSynthetic(model) {
  const synth = new Map();
  for (const a of model.snap.areas) {
    synth.set(a.id, { id: a.id, type: "area", label: a.label, parent: null, desc: "", kids: a.modules, data: { reasons: a.reasons } });
  }
  const groups = new Map();
  for (const n of Object.values(model.nodes)) {
    if (n.type !== "endpoint") continue;
    const key = routeGroupKey(n.data.route);
    const id = `routegroup:${key}`;
    if (!groups.has(id)) groups.set(id, { id, type: "routegroup", label: key, parent: null, desc: "", kids: [], data: {} });
    groups.get(id).kids.push(n.id);
  }
  for (const g of groups.values()) {
    g.kids.sort((a, b) => model.nodes[a].data.route.localeCompare(model.nodes[b].data.route));
    const levels = countBy(g.kids.map((k) => model.nodes[k].data.auth?.level));
    g.data.levels = levels;
    g.desc = `${g.kids.length} address${g.kids.length > 1 ? "es" : ""} in ${new Set(g.kids.map((k) => model.nodes[k].file)).size} file(s)`;
    synth.set(g.id, g);
  }
  model.synth = synth;
  model.node = (id) => model.nodes[id] ?? synth.get(id) ?? null;
  model.kids = (id) => synth.get(id)?.kids ?? model.children(id);
}

export function routeGroupKey(route) {
  const segs = (route ?? "").split("/").filter(Boolean);
  if (segs[0] !== "api") return `/${segs.slice(0, 1).join("/")}`;
  const take = ["settings", "auth", "company"].includes(segs[1]) && segs[2] && !segs[2].startsWith("{") ? 3 : 2;
  return `/${segs.slice(0, take).join("/")}`;
}

const LAYER_SHORT = { web: "web", api: "API", infrastructure: "infra", domain: "domain", tests: "tests", docs: "docs", config: "config", database: "database", external: "external", security: "security", workflow: "workflow", other: "other" };
const countBy = (list) => list.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});

const AUTH_CHIP = {
  anonymous: ["open, no sign-in", "red"],
  "permission-route": ["permission on route", "blue"],
  "permission-route-computed": ["permission on route", "blue"],
  "permission-handler": ["checked in handler", "blue"],
  "permission-domain": ["checked in rules", "blue"],
  "permission-handler-computed": ["permission at run time", "blue"],
  "permission-allows": ["branches on permission", "blue"],
  "role-handler": ["managers only", "blue"],
  "signed-in": ["sign-in only", "amber"],
  unknown: ["no rule found", "red"],
};

/** A display node for a graph (or synthetic) node. */
export function fromNode(model, id, extra = {}) {
  const n = model.node(id);
  if (!n) return null;
  const chips = [];
  const changed = model.changed(id);
  const kids = model.kids(id).length;
  switch (n.type) {
    case "layer":
      if (kids) chips.push({ text: `${kids} ${n.layer === "database" ? "parts" : "modules"}` });
      break;
    case "module":
      chips.push({ text: LAYER_SHORT[n.layer] ?? n.layer, tone: "purple" });
      if (kids) chips.push({ text: `${kids} ${n.id === "module:database/schema" ? "tables" : "files"}` });
      break;
    case "file":
      if (n.data.lines) chips.push({ text: `${n.data.lines} lines` });
      if (kids) chips.push({ text: `${kids} inside` });
      if (n.data.notAnalyzed) chips.push({ text: "not analyzed", tone: "amber" });
      break;
    case "endpoint": {
      const [t, tone] = AUTH_CHIP[n.data.auth?.level] ?? ["?", "red"];
      chips.push({ text: t, tone });
      if (n.data.callers) chips.push({ text: `${n.data.callers} caller${n.data.callers > 1 ? "s" : ""}` });
      break;
    }
    case "table":
      chips.push({ text: `${n.data.columns.length} columns` });
      if (n.data.policies.length) chips.push({ text: "RLS", tone: "green" });
      break;
    case "permission": {
      const server = model.inc(id).filter((e) => ["guarded-by", "checked-in-handler", "conditional-on"].includes(e.kind)).length;
      chips.push(server ? { text: `${server} server check${server > 1 ? "s" : ""}`, tone: "blue" } : { text: "no server check found", tone: "red" });
      break;
    }
    case "role":
      chips.push({ text: `${model.out(id).filter((e) => e.kind === "default-for").length} permissions` });
      break;
    case "screen":
      if (n.data.phase) chips.push({ text: `phase ${n.data.phase}` });
      if (n.data.kind === "file") chips.push({ text: "file route" });
      break;
    case "area":
      chips.push({ text: `${kids} modules` });
      break;
    case "routegroup": {
      const l = n.data.levels;
      if (l.anonymous) chips.push({ text: `${l.anonymous} open`, tone: "red" });
      if (l["signed-in"]) chips.push({ text: `${l["signed-in"]} sign-in only`, tone: "amber" });
      const guarded = n.kids.length - (l.anonymous ?? 0) - (l["signed-in"] ?? 0) - (l.unknown ?? 0);
      if (guarded) chips.push({ text: `${guarded} with permission`, tone: "blue" });
      break;
    }
    case "step":
      if (n.data.who) chips.push({ text: n.data.who });
      if (n.data.note) chips.push({ text: n.data.note, tone: "amber" });
      break;
    case "package":
    case "integration":
      if (n.desc && n.type === "package") chips.push({ text: n.desc });
      break;
  }
  if (changed) chips.push({ text: n.type === "file" ? n.changed : `${changed} changed`, tone: "green", dot: true, push: true });
  const iconName = n.type === "layer" ? n.layer : n.type;
  const desc = n.type === "layer" ? n.data?.stats ?? n.desc : n.type === "package" ? "" : n.desc;
  return {
    id,
    node: id,
    label: n.label,
    desc,
    icon: iconName,
    kind: n.type === "layer" ? n.layer : n.type === "module" || n.type === "file" ? n.layer : n.type,
    chips,
    claims: [id],
    changed: !!changed,
    drill: kids > 0 || ["endpoint", "table", "permission", "role", "screen", "integration", "step", "type", "package"].includes(n.type),
    ...extra,
  };
}

const col = (title, nodes, opts = {}) => ({ title, nodes: nodes.filter(Boolean), ...opts });
const claimsOf = (cols) => {
  const m = new Map();
  for (const c of cols) for (const n of c.nodes) for (const id of n.claims ?? []) if (!m.has(id)) m.set(id, n.id);
  return m;
};
const lift = (model, state, cols, onlyKinds) => liftEdges(model, claimsOf(cols), edgeFilter(state), onlyKinds ? new Set(onlyKinds) : null);
const nodesOfType = (model, type, pred = () => true) => Object.values(model.nodes).filter((n) => n.type === type && pred(n));
const layerModules = (model, layer, pred = () => true) => model.children(`layer:${layer}`).filter((id) => model.nodes[id].type === "module" && pred(model.nodes[id]));

export function buildView(model, state) {
  if (state.focus) return focusView(model, state, state.focus);
  const fn = BUILDERS[state.view] ?? BUILDERS.overview;
  return fn(model, state);
}

const BUILDERS = {
  overview(model, state) {
    const src = model.snap.descriptionSource;
    const ext = nodesOfType(model, "integration").map((n) => fromNode(model, n.id));
    const cols = [
      col("Front end and checks", [fromNode(model, "layer:web"), fromNode(model, "layer:tests"), fromNode(model, "layer:docs")]),
      col("Server", [fromNode(model, "layer:api"), fromNode(model, "layer:security")]),
      col("Inside the server", [fromNode(model, "layer:infrastructure"), fromNode(model, "layer:domain")]),
      col("Data and outside services", [fromNode(model, "layer:database"), ...ext, fromNode(model, "module:external/nuget"), fromNode(model, "module:external/npm")]),
    ];
    return {
      key: "overview",
      eyebrow: "Overview",
      title: model.snap.title ?? model.snap.repoName,
      description: model.snap.description ?? "",
      descSource: src && src !== ".architecture-explorer.json" ? { file: src, line: 1, label: `from ${src}` } : null,
      columns: cols,
      edges: lift(model, state, cols),
      density: "normal",
      edgeMode: "all",
    };
  },

  architecture(model, state) {
    // One box per detected C# project (its layer plus its .csproj), the frontend app(s), tests, and outside parts.
    const projects = model.snap.layout?.projects ?? [];
    const csproj = (p) => `file:${p.dir ? `${p.dir}/` : ""}${p.name}.csproj`;
    const byLayer = (layer) => projects.filter((p) => p.layer === layer);
    const layerBox = (layer, title) => {
      const d = fromNode(model, `layer:${layer}`);
      if (!d) return null;
      const ps = byLayer(layer);
      d.claims = [d.id, ...ps.map(csproj)];
      if (ps.length) d.label = `${d.label} · ${ps.map((p) => p.name).join(", ")}`;
      if (title) d.label = title;
      return d;
    };
    const web = fromNode(model, "layer:web");
    const roots = model.snap.layout?.frontendRoots ?? [];
    web.claims = [web.id, ...roots.map((r) => `file:${r ? `${r}/` : ""}package.json`)];
    const tests = layerBox("tests");
    const build = fromNode(model, "module:config/projects");
    if (build) build.label = "Solution and build settings";
    const cols = [
      col("Front end", [roots.length ? web : null, tests, build]),
      col("API", [layerBox("api")]),
      col("Infrastructure", [layerBox("infrastructure")]),
      col("Domain", [layerBox("domain")]),
      col("Data, services, packages", [fromNode(model, "layer:database"), ...nodesOfType(model, "integration").map((n) => fromNode(model, n.id)), fromNode(model, "module:external/nuget"), fromNode(model, "module:external/npm")]),
    ].filter((c) => c.nodes.some(Boolean));

    return {
      key: "architecture",
      eyebrow: "Software architecture",
      title: "Projects and layers",
      description: `${projects.length} C# project${projects.length === 1 ? "" : "s"} (each placed in a layer by its name or the config) and ${roots.length} frontend app${roots.length === 1 ? "" : "s"}. Lines are every relationship the scan found between them (project references, HTTP calls, injected services, SQL, type references), lifted to project level.`,
      columns: cols,
      edges: lift(model, state, cols),
      density: "normal",
      edgeMode: "all",
    };
  },

  modules(model, state) {
    const areas = [...model.synth.values()].filter((s) => s.type === "area").sort((a, b) => b.kids.length - a.kids.length);
    const k = Math.max(3, Math.ceil(Math.sqrt(areas.length * 1.6)));
    const cols = Array.from({ length: k }, () => col("", []));
    areas.forEach((a, i) => {
      const d = fromNode(model, a.id);
      d.claims = [...a.kids];
      const layers = [...new Set(a.kids.map((m) => model.nodes[m]?.layer))];
      d.desc = `${layers.join(" · ")}`;
      d.chips = [{ text: `${a.kids.length} modules` }, ...(model.changed(a.id) ? [] : [])];
      const changed = a.kids.reduce((s, m) => s + model.changed(m), 0);
      if (changed) d.chips.push({ text: `${changed} changed`, tone: "green", dot: true, push: true });
      cols[i % k].nodes.push(d);
    });
    return {
      key: "modules",
      eyebrow: "Functional modules",
      title: "Feature areas",
      description: "A feature folder that exists in several projects (Features/Orders in Api, Infrastructure, Domain and the tests) is one area, by the project's naming convention. A web folder joins the area it calls most. Hover an area to see what it connects to; double-click to open it.",
      columns: cols,
      edges: lift(model, state, cols),
      density: "normal",
      edgeMode: "focus",
      keepOrder: true,
    };
  },

  structure(model, state) {
    return treeView(model, state);
  },

  dependencies(model, state) {
    const mods = (layer) => layerModules(model, layer).map((id) => fromNode(model, id, { compact: true }));
    const cols = [
      col("Web", mods("web").filter((d) => d.id !== "module:web/screens")),
      col("API", mods("api")),
      col("Infrastructure", mods("infrastructure")),
      col("Domain", mods("domain")),
      col("Data", [fromNode(model, "module:database/schema", { compact: true })]),
    ];
    return {
      key: "dependencies",
      eyebrow: "Module dependencies",
      title: "Which module depends on which",
      description: "Lines are imports (TypeScript, verified), API calls, injected services, SQL table use (verified) and C# type references (name matches, inferred, dashed). Hover a module to isolate its dependencies.",
      columns: cols,
      edges: lift(model, state, cols, ["imports", "uses-type", "calls-api", "injects", "uses", "binds", "reads", "writes", "reads-writes", "implements", "implemented-by"]),
      density: "compact",
      edgeMode: "faint",
    };
  },

  frontend(model, state) {
    const screens = nodesOfType(model, "screen").map((n) => fromNode(model, n.id, { compact: true }));
    const web = layerModules(model, "web", (n) => n.id !== "module:web/screens").map((id) => fromNode(model, id, { compact: true }));
    const api = layerModules(model, "api").map((id) => fromNode(model, id, { compact: true }));
    const cols = [col("Screens", screens), col("Web modules", web), col("API modules", api), col("Not matched", [fromNode(model, "unresolved:api", { compact: true })])];
    return {
      key: "frontend",
      eyebrow: "Frontend ↔ backend",
      title: "Screens, their code, and the API they call",
      description: `Screens come from the app's router (React Router, switch-based routers, Next.js folders). Calls are every fetch, axios, API-client and api*/http* helper call in the frontend, with its path worked out and matched to a server route: ${model.snap.callStats.verified} exact, ${model.snap.callStats.inferred} with dynamic segments or a base address, ${model.snap.callStats.unresolved} unmatched.`,
      columns: cols,
      edges: lift(model, state, cols, ["renders", "imports", "calls-api", "reaches-api"]),
      density: "compact",
      edgeMode: "all",
    };
  },

  api(model, state) {
    const groups = [...model.synth.values()].filter((s) => s.type === "routegroup").sort((a, b) => a.label.localeCompare(b.label));
    const groupNodes = groups.map((g) => {
      const d = fromNode(model, g.id, { compact: true });
      d.claims = [...g.kids];
      return d;
    });
    const callers = layerModules(model, "web", (n) => n.id !== "module:web/screens").map((id) => fromNode(model, id, { compact: true }));
    const testMods = layerModules(model, "tests").map((id) => fromNode(model, id, { compact: true }));
    const injected = new Set();
    for (const e of model.edges) if (e.kind === "injects") injected.add(e.to);
    const services = [...injected].map((id) => fromNode(model, id, { compact: true })).sort((a, b) => a.label.localeCompare(b.label));
    const cols = [
      col("Callers: screens' code and tests", [...callers, ...testMods]),
      col("API route groups", groupNodes),
      col("Services the handlers inject", services),
      col("Data", [fromNode(model, "module:database/schema", { compact: true })]),
    ];
    return {
      key: "api",
      eyebrow: "API connections",
      title: `${Object.values(model.nodes).filter((n) => n.type === "endpoint").length} addresses`,
      description: "Route groups by path. Each handler's parameters show which stores it uses (verified from the handler's signature); stores lead to the tables in their SQL. Double-click a group for its addresses.",
      columns: cols,
      edges: lift(model, state, cols, ["calls-api", "tests", "injects", "reads", "writes", "reads-writes"]),
      density: "compact",
      edgeMode: "faint",
    };
  },

  database(model, state) {
    const tables = nodesOfType(model, "table");
    const depth = new Map();
    const visiting = new Set();
    const d = (id) => {
      if (depth.has(id)) return depth.get(id);
      if (visiting.has(id)) return 0;
      visiting.add(id);
      const targets = model.out(id).filter((e) => e.kind === "fk" && e.to !== id).map((e) => e.to);
      const v = targets.length ? 1 + Math.max(...targets.map(d)) : 0;
      visiting.delete(id);
      depth.set(id, v);
      return v;
    };
    tables.forEach((t) => d(t.id));
    const max = Math.max(0, ...depth.values());
    const cols = Array.from({ length: max + 1 }, (_, i) => col(i === 0 ? "Referenced by others (no foreign keys out)" : `${i} step${i > 1 ? "s" : ""} from the root tables`, []));
    for (const t of tables.sort((a, b) => a.label.localeCompare(b.label))) cols[depth.get(t.id)].nodes.push(fromNode(model, t.id, { compact: true }));
    const counts = model.snap.schema.counts;
    return {
      key: "database",
      eyebrow: "Database relationships",
      title: `${tables.length} tables`,
      description: `The schema after replaying ${nodesOfType(model, "file", (n) => n.file.startsWith("db/migrations/")).length} migrations in order (${counts.createTable} CREATE TABLE, ${counts.alterActions} ALTER TABLE actions, ${model.snap.schema.dropped.length} DROP TABLE). Lines are foreign keys, pointing to the table they reference.`,
      columns: cols.filter((c) => c.nodes.length),
      edges: lift(model, state, cols, ["fk"]),
      density: "compact",
      edgeMode: "faint",
    };
  },

  workflow(model, state) {
    const steps = nodesOfType(model, "step").sort((a, b) => a.data.number - b.data.number);
    const cols = [];
    const edges = [];
    for (const s of steps) {
      const sd = fromNode(model, s.id);
      const mods = model.out(s.id).filter((e) => e.kind === "step-in" && state.statuses.inferred);
      const modNodes = mods.slice(0, 7).map((e) => {
        const md = fromNode(model, e.to, { compact: true, id: `${s.id}|${e.to}` });
        md.claims = [];
        md.label = `${md.label}`;
        md.desc = model.nodes[e.to]?.layer ?? "";
        edges.push({ id: `${s.id}→${md.id}`, from: s.id, to: md.id, count: 1, verified: 0, inferred: 1, unresolved: 0, status: "inferred", kinds: new Set(["step-in"]), edgeIdx: [e.idx] });
        return md;
      });
      if (mods.length > 7) modNodes.push({ id: `${s.id}|more`, label: `+${mods.length - 7} more`, desc: "open the step to see all", icon: "module", kind: "module", chips: [], claims: [], compact: true, drill: false, node: s.id });
      cols.push(col(`Step ${s.data.number}`, [sd, ...modNodes]));
    }
    for (let i = 1; i < steps.length; i++) {
      const e = model.out(steps[i - 1].id).find((x) => x.kind === "next-step");
      edges.push({ id: `${steps[i - 1].id}→${steps[i].id}`, from: steps[i - 1].id, to: steps[i].id, count: 1, verified: 1, inferred: 0, unresolved: 0, status: "verified", kinds: new Set(["next-step"]), edgeIdx: e ? [e.idx] : [] });
    }
    const wf = model.snap.workflow;
    return {
      key: "workflow",
      eyebrow: "Business workflow",
      title: steps.length ? `The business workflow: ${steps.length} steps` : "No workflow configured",
      description: steps.length ? `The steps, their order and who does each come from ${wf.source}. Which modules belong to each step is a keyword list kept in .architecture-explorer.json, so those links are inferred (dashed). Press Flows to walk through it.` : `Workflow ${wf.note ?? "not configured"}. To show one, add "workflow": { "source": "<a Markdown file with a numbered table or list of steps>", "steps": [{ "number": 1, "keywords": ["order"] }] } to .architecture-explorer.json (or ask Claude to set it up).`,
      descSource: wf.source ? { file: wf.source, line: model.nodes[steps[0]?.id]?.line ?? 1, label: `from ${wf.source.split("/").pop()}` } : null,
      columns: cols,
      edges,
      density: "normal",
      edgeMode: "all",
      keepOrder: true,
      rowAligned: true,
    };
  },

  security(model, state) {
    const roles = nodesOfType(model, "role").map((n) => fromNode(model, n.id, { compact: true }));
    const perms = nodesOfType(model, "permission").sort((a, b) => a.data.number - b.data.number).map((n) => fromNode(model, n.id, { compact: true }));
    const groups = [...model.synth.values()].filter((s) => s.type === "routegroup").sort((a, b) => a.label.localeCompare(b.label)).map((g) => {
      const d = fromNode(model, g.id, { compact: true });
      d.claims = [...g.kids];
      return d;
    });
    const web = layerModules(model, "web", (n) => n.id !== "module:web/screens").map((id) => fromNode(model, id, { compact: true }));
    const cols = [col("Roles", roles), col("Permissions and policies", perms), col("API route groups", groups), col("Screens that check", web)];
    const fb = model.snap.fallback;
    const edges = lift(model, state, cols, ["default-for", "guarded-by", "checked-in-handler", "conditional-on", "checks-permission"]);
    return {
      key: "security",
      eyebrow: "Security and permissions",
      title: "Who may do what",
      description: `${fb?.requiresSignIn ? "Every address needs sign-in unless it says AllowAnonymous (fallback policy)." : "No fallback policy was found, so an address without [Authorize] or RequireAuthorization is open."} Permissions and policies come from AddPolicy, [Authorize], RequireAuthorization${model.snap.config?.permissionEnum ? `, the ${model.snap.config.permissionEnum} enum and the configured guards and checks` : ""}; checks in code are followed from each handler. Hover a permission to see who has it and what it protects.`,
      descSource: fb ? { file: fb.file, line: fb.line, label: `fallback policy: ${fb.file.split("/").pop()}:${fb.line}` } : null,
      columns: cols.filter((c) => c.nodes.length),
      edges: edges.filter((e) => cols[3].nodes.some((n) => n.id === e.from || n.id === e.to) ? true : true),
      density: "compact",
      edgeMode: "faint",
    };
  },

  integrations(model, state) {
    const ext = nodesOfType(model, "integration").map((n) => fromNode(model, n.id));
    const users = new Set();
    for (const e of model.edges) if (["calls-external", "connects", "declares"].includes(e.kind)) users.add(e.from);
    const files = [...users].filter((id) => model.nodes[id]?.type === "file").map((id) => fromNode(model, id, { compact: true }));
    const cols = [
      col("Code and project files", files),
      col("Outside services", ext),
      col("Packages", [fromNode(model, "module:external/nuget"), fromNode(model, "module:external/npm")]),
      col("Data", [fromNode(model, "module:database/schema")]),
    ];
    return {
      key: "integrations",
      eyebrow: "External integrations",
      title: "What the system talks to outside this repository",
      description: "Services found in the code itself: an address in a string (server or frontend), or a well-known client package (Npgsql → PostgreSQL, Stripe.net → Stripe, @aws-sdk → AWS; package links are inferred). Services only mentioned in docs are not listed.",
      columns: cols,
      edges: lift(model, state, cols, ["calls-external", "connects", "declares", "hosts"]),
      density: "normal",
      edgeMode: "all",
    };
  },
};

/** "Explore inside": neighbours that use it on the left, its contents in the middle, what it uses on the right. */
export function focusView(model, state, focusId) {
  const n = model.node(focusId);
  if (!n) return BUILDERS.overview(model, state);
  let kids = model.kids(focusId).filter((id) => model.node(id));
  // A file's C# types are many small records: keep the ones that matter (stores, endpoints, enums, interfaces).
  if (n.type === "file" && kids.length > 24) kids = kids.filter((id) => model.nodes[id].type !== "type" || model.inc(id).length || model.out(id).length);
  const center = (kids.length ? kids : [focusId]).map((id) => fromNode(model, id, { compact: kids.length > 10 }));
  const centerIds = new Set(center.map((c) => c.id));
  const filter = edgeFilter(state);

  const insideOwner = new Map();
  const ownerOf = (id) => {
    if (insideOwner.has(id)) return insideOwner.get(id);
    let cur = id;
    let found = null;
    while (cur) {
      if (centerIds.has(cur)) {
        found = cur;
        break;
      }
      cur = model.nodes[cur]?.parent;
    }
    // Synthetic groups (areas, route groups) own their kids' subtrees.
    if (!found && model.synth.has(focusId)) {
      for (const a of [id, ...model.ancestors(id)]) if (centerIds.has(a)) found = a;
    }
    insideOwner.set(id, found);
    return found;
  };
  const focusAncestors = new Set([focusId, ...model.ancestors(focusId)]);
  const fine = (id) => {
    const m = model.nodes[id];
    if (!m) return id;
    if (["type", "endpoint"].includes(m.type)) return model.fileOf(id) ?? id;
    return id;
  };
  // Level 0: the item (a file for C# types and endpoints). Each level climbs one step up the tree (file → module →
  // layer, table → schema → database), never into the item being explored or the system root.
  const coarse = (id, level) => {
    let cur = fine(id);
    for (let i = 0; i < level; i++) {
      const p = model.nodes[cur]?.parent;
      if (!p || p === "system" || focusAncestors.has(p)) break;
      cur = p;
    }
    return cur;
  };
  const neighbours = [];
  for (const e of model.edges) {
    if (!filter(e)) continue;
    const a = ownerOf(e.from);
    const b = ownerOf(e.to);
    if (a && !b) neighbours.push({ id: e.to, dir: "out" });
    else if (b && !a) neighbours.push({ id: e.from, dir: "in" });
  }
  let level = 0;
  let groups;
  for (;;) {
    groups = new Map();
    for (const nb of neighbours) {
      const g = coarse(nb.id, level);
      if (centerIds.has(g) || focusAncestors.has(g)) continue;
      const cur = groups.get(g) ?? { in: 0, out: 0 };
      cur[nb.dir]++;
      groups.set(g, cur);
    }
    if (groups.size <= 28 || level >= 2) break;
    level++;
  }
  const left = [];
  const right = [];
  for (const [g, c] of groups) {
    const d = fromNode(model, g, { compact: true });
    if (!d) continue;
    (c.in >= c.out ? left : right).push(d);
  }
  const cols = [
    col("Used by", left),
    col(kids.length ? `Inside ${n.label}` : n.label, center),
    col("Uses", right),
  ];
  const claims = claimsOf(cols);
  // Only lines that touch what is being explored; neighbour-to-neighbour links belong to their own views.
  const edges = liftEdges(model, claims, filter, null).filter((e) => centerIds.has(e.from) || centerIds.has(e.to));
  const typeLabel = TYPE_LABEL[n.type] ?? n.type;
  return {
    key: `focus:${focusId}`,
    eyebrow: n.layer && n.type !== "layer" ? `${typeLabel} · ${LAYER_SHORT[n.layer] ?? n.layer}` : typeLabel,
    title: n.label,
    description: n.type === "layer" ? `${n.desc}. ${n.data?.stats ?? ""}` : n.desc || (n.type === "area" ? "Modules in this area, across the projects." : ""),
    descSource: n.file && n.type !== "file" ? { file: n.file, line: n.line ?? 1, label: `${n.file}:${n.line ?? 1}` } : n.data?.descFrom ? { file: n.data.descFrom, line: 1, label: `summary from ${n.data.descFrom.split("/").pop()}` } : null,
    columns: cols.filter((c, i) => i === 1 || c.nodes.length),
    edges,
    density: center.length > 10 ? "compact" : "normal",
    edgeMode: edges.length > 160 ? "faint" : "all",
    focus: focusId,
    groupedLevel: level,
  };
}

/** Folder tree with expand / collapse. */
function treeView(model, state) {
  const files = Object.values(model.nodes).filter((n) => n.type === "file");
  const root = { name: model.snap.repoName, path: "", dirs: new Map(), files: [], count: 0, lines: 0, changed: 0 };
  for (const f of files) {
    const parts = f.file.split("/");
    let cur = root;
    cur.count++;
    cur.lines += f.data.lines ?? 0;
    if (f.changed) cur.changed++;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join("/");
      if (!cur.dirs.has(parts[i])) cur.dirs.set(parts[i], { name: parts[i], path: p, dirs: new Map(), files: [], count: 0, lines: 0, changed: 0 });
      cur = cur.dirs.get(parts[i]);
      cur.count++;
      cur.lines += f.data.lines ?? 0;
      if (f.changed) cur.changed++;
    }
    cur.files.push(f);
  }
  const expanded = state.expanded;
  const nodesOut = [];
  const edges = [];
  const W = 250;
  const H = 58;
  const GX = 300;
  const GY = 68;
  let row = 0;
  const place = (dir, depth, parentId) => {
    const id = `dir:${dir.path}`;
    const open = expanded.has(dir.path);
    const start = row;
    const kidsPos = [];
    if (open) {
      for (const sub of [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) kidsPos.push(place(sub, depth + 1, id));
      for (const f of dir.files.sort((a, b) => a.label.localeCompare(b.label))) {
        const d = fromNode(model, f.id, { compact: true });
        d.x = (depth + 1) * GX;
        d.y = row * GY;
        d.w = W;
        d.h = H;
        row++;
        nodesOut.push(d);
        edges.push({ id: `${id}→${d.id}`, from: id, to: d.id, status: "tree", count: 1, kinds: new Set(), edgeIdx: [] });
        kidsPos.push(d.y);
      }
    }
    if (!kidsPos.length) row++;
    const y = kidsPos.length ? (kidsPos[0] + kidsPos[kidsPos.length - 1]) / 2 : start * GY;
    const chips = [{ text: `${dir.count} files` }];
    if (dir.lines) chips.push({ text: `${dir.lines.toLocaleString()} lines` });
    if (dir.changed) chips.push({ text: `${dir.changed} changed`, tone: "green", dot: true, push: true });
    nodesOut.push({ id, label: dir.path ? dir.name : model.snap.repoName, desc: "", icon: "dir", kind: "dir", dir: { path: dir.path, open, hasKids: dir.dirs.size + dir.files.length > 0 }, chips, claims: [], compact: true, x: depth * GX, y, w: W, h: H, drill: false });
    if (parentId) edges.push({ id: `${parentId}→${id}`, from: parentId, to: id, status: "tree", count: 1, kinds: new Set(), edgeIdx: [] });
    return y;
  };
  place(root, 0, null);
  return {
    key: "structure",
    eyebrow: "Code structure",
    title: "Folders and files",
    description: "Every file the explorer indexed (bin, obj, node_modules and build output are skipped). Click a folder to open or close it; click a file for its details.",
    columns: [],
    positioned: nodesOut,
    edges,
    density: "compact",
    edgeMode: "all",
    keepCamera: true,
  };
}

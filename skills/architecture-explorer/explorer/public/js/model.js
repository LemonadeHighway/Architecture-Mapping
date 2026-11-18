// Indexes the snapshot for fast lookups, and lifts leaf relationships up to whatever is drawn on screen.

export const KIND_GROUPS = [
  { id: "calls", label: "Calls (screens → API, tests)", kinds: ["calls-api", "tests", "renders"] },
  { id: "reach", label: "Screen reaches API through imports", kinds: ["reaches-api"], off: true },
  { id: "code", label: "Code (imports, types, services)", kinds: ["imports", "uses-type", "implements", "registers", "implemented-by", "injects", "uses", "binds"] },
  { id: "data", label: "Data (SQL, foreign keys, migrations)", kinds: ["reads", "writes", "reads-writes", "fk", "creates", "alters", "touches", "hosts", "connects"] },
  { id: "security", label: "Permissions", kinds: ["guarded-by", "checked-in-handler", "conditional-on", "checks-permission", "references", "default-for"] },
  { id: "packages", label: "Packages and outside services", kinds: ["declares", "project-ref", "calls-external"] },
  { id: "docs", label: "Docs that mention code", kinds: ["mentions"], off: true },
  { id: "workflow", label: "Workflow mapping", kinds: ["step-in", "step-endpoint", "next-step"] },
];
export const KIND_LABEL = {
  "calls-api": "calls", tests: "tests", renders: "renders", "reaches-api": "reaches (imports)", imports: "imports",
  "uses-type": "uses types of", implements: "implements", registers: "registers", "implemented-by": "implemented by",
  injects: "injects", uses: "uses", binds: "binds", reads: "reads", writes: "writes", "reads-writes": "reads and writes",
  fk: "foreign key to", creates: "creates", alters: "alters", touches: "touches", hosts: "hosts", connects: "connects to",
  "guarded-by": "guarded by", "checked-in-handler": "checks in code", "conditional-on": "branches on",
  "checks-permission": "screen checks", references: "names", "default-for": "has by default", declares: "declares",
  "project-ref": "references project", "calls-external": "calls", mentions: "mentions", "step-in": "step uses",
  "step-endpoint": "step uses address", "next-step": "then",
};
export const TYPE_LABEL = {
  system: "System", layer: "Layer", module: "Module", file: "File", type: "C# type", endpoint: "API address", table: "Table",
  permission: "Permission", role: "Role", screen: "Screen", integration: "Outside service", package: "Package",
  step: "Workflow step", unresolved: "Unresolved", area: "Functional area", routegroup: "Route group", dir: "Folder",
};

export function buildModel(snap) {
  const nodes = snap.nodes;
  const children = new Map();
  const out = new Map();
  const inc = new Map();
  for (const n of Object.values(nodes)) {
    if (!n.parent) continue;
    if (!children.has(n.parent)) children.set(n.parent, []);
    children.get(n.parent).push(n.id);
  }
  for (const list of children.values()) list.sort((a, b) => (nodes[a].label ?? "").localeCompare(nodes[b].label ?? ""));
  snap.edges.forEach((e, i) => {
    e.idx = i;
    if (!out.has(e.from)) out.set(e.from, []);
    if (!inc.has(e.to)) inc.set(e.to, []);
    out.get(e.from).push(e);
    inc.get(e.to).push(e);
  });
  const ancestors = (id) => {
    const list = [];
    let cur = nodes[id]?.parent;
    while (cur) {
      list.push(cur);
      cur = nodes[cur]?.parent;
    }
    return list;
  };
  // Changed files per node (git status), counted up the tree.
  const changed = new Map();
  for (const n of Object.values(nodes)) {
    if (n.type !== "file" || !n.changed) continue;
    for (const a of [n.id, ...ancestors(n.id)]) changed.set(a, (changed.get(a) ?? 0) + 1);
  }
  const areaOf = new Map();
  for (const a of snap.areas) for (const m of a.modules) areaOf.set(m, a);
  const moduleOf = (id) => {
    let cur = id;
    while (cur && nodes[cur] && nodes[cur].type !== "module") cur = nodes[cur].parent;
    return nodes[cur]?.type === "module" ? cur : null;
  };
  const fileOf = (id) => {
    let cur = id;
    while (cur && nodes[cur] && nodes[cur].type !== "file") cur = nodes[cur].parent;
    return nodes[cur]?.type === "file" ? cur : null;
  };
  const descendants = (id) => {
    const list = [];
    const stack = [...(children.get(id) ?? [])];
    while (stack.length) {
      const c = stack.pop();
      list.push(c);
      stack.push(...(children.get(c) ?? []));
    }
    return list;
  };
  return {
    snap,
    nodes,
    edges: snap.edges,
    children: (id) => children.get(id) ?? [],
    out: (id) => out.get(id) ?? [],
    inc: (id) => inc.get(id) ?? [],
    ancestors,
    descendants,
    changed: (id) => changed.get(id) ?? 0,
    areaOf: (moduleId) => areaOf.get(moduleId) ?? null,
    moduleOf,
    fileOf,
    get: (id) => nodes[id],
  };
}

/** Edge filter from the UI state. */
export function edgeFilter(state) {
  const enabledKinds = new Set();
  for (const g of KIND_GROUPS) if (state.kindGroups[g.id]) for (const k of g.kinds) enabledKinds.add(k);
  return (e) => enabledKinds.has(e.kind) && state.statuses[e.status];
}

/**
 * Lifts every graph edge to the display nodes that contain its ends. `claims` maps graph node id -> display id; the
 * deepest claimed ancestor of a node wins, so a file shown on its own beats the module that contains it.
 */
export function liftEdges(model, claims, filter, onlyKinds) {
  const ownerCache = new Map();
  const owner = (id) => {
    if (ownerCache.has(id)) return ownerCache.get(id);
    let cur = id;
    let found = null;
    while (cur) {
      if (claims.has(cur)) {
        found = claims.get(cur);
        break;
      }
      cur = model.nodes[cur]?.parent;
    }
    ownerCache.set(id, found);
    return found;
  };
  const agg = new Map();
  for (const e of model.edges) {
    if (onlyKinds && !onlyKinds.has(e.kind)) continue;
    if (filter && !filter(e)) continue;
    const a = owner(e.from);
    const b = owner(e.to);
    if (!a || !b || a === b) continue;
    const key = `${a}→${b}`;
    let d = agg.get(key);
    if (!d) {
      d = { id: key, from: a, to: b, count: 0, verified: 0, inferred: 0, unresolved: 0, kinds: new Set(), edgeIdx: [] };
      agg.set(key, d);
    }
    d.count += e.count ?? 1;
    d[e.status] += 1;
    d.kinds.add(e.kind);
    if (d.edgeIdx.length < 400) d.edgeIdx.push(e.idx);
  }
  for (const d of agg.values()) d.status = d.verified ? "verified" : d.inferred ? "inferred" : "unresolved";
  return [...agg.values()];
}

// Small inline icons (stroke paths), keyed by node type or layer.
const P = {
  system: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><path d="M10 6.5h4a3 3 0 0 1 3 3V14"/>',
  web: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  api: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  infrastructure: '<path d="M4 7h16M4 12h16M4 17h16"/><circle cx="8" cy="7" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="16" cy="17" r="1"/>',
  domain: '<path d="M12 3 4 7.5v9L12 21l8-4.5v-9z"/><path d="M12 12 4 7.5M12 12l8-4.5M12 12v9"/>',
  database: '<ellipse cx="12" cy="5.5" rx="8" ry="2.5"/><path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5"/>',
  external: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  security: '<path d="M12 3 5 6v6c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6z"/>',
  tests: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3"/>',
  docs: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h7"/>',
  config: '<circle cx="12" cy="12" r="3"/><path d="M19 12h2M3 12h2M12 3v2M12 19v2M17 7l1.4-1.4M5.6 18.4 7 17M17 17l1.4 1.4M5.6 5.6 7 7"/>',
  workflow: '<path d="M5 12h4l3-6 3 12 3-6h2"/>',
  other: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/>',
  module: '<path d="M12 3 4 7l8 4 8-4zM4 12l8 4 8-4M4 17l8 4 8-4"/>',
  file: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/>',
  dir: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  type: '<path d="M8 4c-2 0-3 1-3 3v2c0 1.5-1 2.5-2 3 1 .5 2 1.5 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1.5 1 2.5 2 3-1 .5-2 1.5-2 3v2c0 2-1 3-3 3"/>',
  endpoint: '<path d="M4 12h12M12 6l6 6-6 6"/><path d="M20 5v14"/>',
  routegroup: '<path d="M4 7h12M4 12h12M4 17h12"/><path d="m17 5 3 2-3 2M17 10l3 2-3 2M17 15l3 2-3 2"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M9 9v11"/>',
  permission: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  role: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  screen: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 8h18"/>',
  integration: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  package: '<path d="M12 3 4 7v10l8 4 8-4V7z"/><path d="M4 7l8 4 8-4M12 11v10"/>',
  step: '<circle cx="12" cy="12" r="8"/><path d="M10 8l5 4-5 4z"/>',
  unresolved: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>',
  area: '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/>',
};
export function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${P[name] ?? P.other}</svg>`;
}

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// The prompt bar. There is no AI here: questions are matched against the scan index (names, routes, tables,
// permissions) with a few question shapes, and fall back to a text search of the repository. Nothing leaves this
// computer. Each answer can be copied as a prompt for Claude Code with the relevant file:line references.
import { KIND_LABEL } from "./model.js";

const STOP = new Set("a an the is are do does did of to in on for and or with what which who whom where when how why can could should would i we it this that these those from by be add put implement build new feature page screen code there any all me my our".split(" "));

export async function answer(question, model) {
  const q = question.trim();
  const lower = q.toLowerCase();
  const entities = findEntities(q, model);
  const items = [];
  const push = (item) => items.length < 60 && items.push(item);

  const intent =
    /\b(who|what|which)\b.*\b(calls?|uses?|depends?|imports?|reads?|writes?)\b.*\?*$/.test(lower) && /\b(who|which)\b/.test(lower) ? "incoming"
    : /\b(used by|callers?|called from|where is .* used|depends on it|who uses)\b/.test(lower) ? "incoming"
    : /\bwhat does\b|\bdepend(s)? on\b|\buses\b|\bcalls\b/.test(lower) ? "outgoing"
    : /\b(who can|permission|allowed|access|guard|protect|role|user type)\b/.test(lower) ? "security"
    : /\b(where should|where do i|where would|where to|implement|add (a|an|the)?|put)\b/.test(lower) ? "where"
    : /\b(open|anonymous|without sign|no sign|public)\b/.test(lower) ? "open"
    : /\b(unused|dead|orphan|no callers?)\b/.test(lower) ? "unused"
    : /\b(changed|recent|uncommitted|modified)\b/.test(lower) ? "changes"
    : entities.length ? "about" : "search";

  const ent = entities[0];
  let title = "";
  let text = "";

  if (intent === "open") {
    const eps = Object.values(model.nodes).filter((n) => n.type === "endpoint" && n.data.auth?.level === "anonymous");
    title = `${eps.length} addresses are open without sign-in`;
    text = "They are marked AllowAnonymous. Everything else needs sign-in (the fallback policy) and many also need a permission.";
    eps.forEach((e) => push({ id: e.id, label: `${e.data.verb} ${e.data.route}`, sub: `${e.file}:${e.line}`, file: e.file, line: e.line }));
  } else if (intent === "unused") {
    const f = model.snap.findings.find((x) => /no caller/.test(x.title));
    title = f ? f.title : "Every address has a caller the scanner can see";
    text = f?.detail ?? "";
    f?.evidence.forEach((e) => push({ id: e.node, label: e.note, sub: `${e.file}:${e.line}`, file: e.file, line: e.line }));
  } else if (intent === "changes") {
    const g = model.snap.git;
    title = `${g.changed.length} uncommitted changes on ${g.branch}`;
    text = "From git status. The map marks these files (and the modules that hold them) with a green edge.";
    g.changed.forEach((c) => push({ id: model.nodes[`file:${c.path}`] ? `file:${c.path}` : null, label: c.path, sub: c.status, file: c.path, line: 1 }));
  } else if (intent === "where") {
    const words = lower.replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
    const areas = [...model.synth.values()].filter((s) => s.type === "area");
    const scored = areas.map((a) => {
      const hay = [a.label, ...a.kids.map((k) => model.node(k)?.label ?? ""), ...a.kids.flatMap((k) => model.kids(k).slice(0, 80).map((f) => model.node(f)?.label ?? ""))].join(" ").toLowerCase();
      return { a, score: words.reduce((s, w) => s + (hay.includes(w.replace(/s$/, "")) ? 1 : 0), 0) };
    }).sort((x, y) => y.score - x.score);
    const best = scored[0]?.score ? scored[0].a : null;
    if (best) {
      title = `Closest existing area: ${best.label}`;
      text = `The project uses vertical slices (Features/[Domain]/[Feature]) in each project. New work for this area would normally sit beside these modules. This is a suggestion from folder names and code that matches your words, not a rule the code enforces.`;
      for (const m of best.kids) {
        const mn = model.node(m);
        const anyFile = model.kids(m).map((k) => model.node(k)).find((n) => n?.file);
        push({ id: m, label: `${mn.label} (${mn.layer})`, sub: anyFile ? anyFile.file.replace(/[^/]+$/, "") : "", file: anyFile?.file, line: 1 });
      }
    } else {
      title = "No existing area matches those words";
      text = "Nothing in the code is named like this yet, so it would be a new feature folder following the project's existing layout (look at how the closest feature is split across the projects and the frontend).";
    }
    if (model.snap.config?.permissionEnum) text += ` New actions in this project usually also get a ${model.snap.config.permissionEnum} value, a guard on the address and a check on the screen: see how an existing address in this area is guarded (Security view).`;
    const docs = await textSearch(words.slice(0, 2).join(" "), true);
    docs.slice(0, 8).forEach((h) => push({ label: h.text, sub: `${h.file}:${h.line}`, file: h.file, line: h.line, doc: true }));
  } else if (ent && (intent === "incoming" || intent === "outgoing" || intent === "about" || intent === "security")) {
    const n = model.node(ent);
    if (intent === "security" && n.type === "endpoint") {
      const a = n.data.auth;
      title = `${n.data.verb} ${n.data.route}: ${a.level.replace(/-/g, " ")}`;
      text = n.desc;
      for (const p of a.routePermissions) push({ id: `perm:${p.permission}`, label: `Route guard: ${p.permission}`, sub: `${p.file}:${p.line}`, file: p.file, line: p.line, status: "verified" });
      for (const r of a.handlerRequires) push({ id: r.permission ? `perm:${r.permission}` : null, label: `Checks ${r.permission ?? r.argText}`, sub: `${r.file}:${r.line} · ${r.via}`, file: r.file, line: r.line, status: r.inferred ? "inferred" : "verified" });
      for (const r of a.handlerAllows) push({ id: r.permission ? `perm:${r.permission}` : null, label: `Branches on ${r.permission ?? r.argText}`, sub: `${r.file}:${r.line} · ${r.via}`, file: r.file, line: r.line, status: r.inferred ? "inferred" : "verified" });
    } else if (intent === "security" && n.type === "permission") {
      const roles = model.inc(ent).filter((e) => e.kind === "default-for");
      const guards = model.inc(ent).filter((e) => ["guarded-by", "checked-in-handler", "conditional-on"].includes(e.kind));
      title = `${n.label}: ${roles.length} roles by default, ${guards.length} server checks`;
      text = n.desc;
      roles.forEach((e) => push({ id: e.from, label: `${model.node(e.from).label} has it by default`, sub: `${e.evidence[0].file}:${e.evidence[0].line}`, file: e.evidence[0].file, line: e.evidence[0].line, status: e.status }));
      guards.forEach((e) => push({ id: e.from, label: `${KIND_LABEL[e.kind]}: ${model.node(e.from).label}`, sub: `${e.evidence[0].file}:${e.evidence[0].line}`, file: e.evidence[0].file, line: e.evidence[0].line, status: e.status }));
    } else {
      const dir = intent === "outgoing" ? "out" : intent === "incoming" ? "in" : "both";
      const list = [...(dir !== "out" ? model.inc(ent).map((e) => ({ e, other: e.from, d: "in" })) : []), ...(dir !== "in" ? model.out(ent).map((e) => ({ e, other: e.to, d: "out" })) : [])];
      // A module or file: include what its contents connect to.
      if (!list.length || ["module", "layer", "area", "routegroup"].includes(n.type)) {
        for (const k of model.kids(ent).flatMap((c) => [c, ...model.descendants(c)])) {
          if (dir !== "out") model.inc(k).forEach((e) => list.push({ e, other: e.from, d: "in" }));
          if (dir !== "in") model.out(k).forEach((e) => list.push({ e, other: e.to, d: "out" }));
        }
      }
      title = `${n.label}: ${dir === "in" ? "what uses it" : dir === "out" ? "what it uses" : "its connections"} (${list.length})`;
      text = n.desc ?? "";
      list.sort((a, b) => (a.e.status === "verified" ? -1 : 1) - (b.e.status === "verified" ? -1 : 1));
      for (const { e, other, d } of list) {
        const on = model.node(other);
        const ev = e.evidence[0];
        push({ id: other, label: `${d === "in" ? "←" : "→"} ${KIND_LABEL[e.kind] ?? e.kind} ${on?.label ?? other}`, sub: ev ? `${ev.file}:${ev.line} ${ev.note ?? ""}` : "", file: ev?.file, line: ev?.line, status: e.status });
      }
    }
  } else {
    title = entities.length ? "Matches in the index" : `Searching for "${q}"`;
    text = entities.length ? "" : "No name in the index matches; these are text matches in the repository.";
    entities.slice(0, 12).forEach((id) => push({ id, label: model.node(id).label, sub: model.node(id).file ?? id }));
    const hits = await textSearch(q.replace(/[?]/g, "").trim());
    hits.slice(0, 30).forEach((h) => push({ label: h.text, sub: `${h.file}:${h.line}`, file: h.file, line: h.line }));
  }
  const prompt = `${q}\n\nContext from the architecture explorer (static scan of this repository):\n${title}\n${text}\n${items.slice(0, 30).map((i) => `- ${i.label}${i.sub ? ` (${i.sub})` : ""}`).join("\n")}\n\nCheck these places in the code before answering.`;
  return { title, text, items, prompt, entities };
}

async function textSearch(q, docsOnly = false) {
  if (!q || q.length < 2) return [];
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const { hits } = await r.json();
    return docsOnly ? hits.filter((h) => /\.md$/.test(h.file)) : hits;
  } catch {
    return [];
  }
}

/** Names from the index that appear in the question, best first. */
export function findEntities(q, model) {
  const out = [];
  const lower = q.toLowerCase();
  const route = /\/?api\/[\w/{}:.\-*]+/i.exec(q);
  if (route) {
    const segs = route[0].replace(/^\//, "").split("/").filter(Boolean);
    for (const n of Object.values(model.nodes)) {
      if (n.type !== "endpoint") continue;
      const es = n.data.route.replace(/^\//, "").split("/").filter(Boolean);
      if (es.length !== segs.length) continue;
      if (es.every((s, i) => s.startsWith("{") || segs[i].startsWith("{") || s.toLowerCase() === segs[i].toLowerCase())) out.push(n.id);
    }
  }
  const words = q.match(/[A-Za-z_][\w.]*/g) ?? [];
  const byLabel = new Map();
  for (const n of [...Object.values(model.nodes), ...model.synth.values()]) {
    const key = (n.label ?? "").toLowerCase();
    if (!byLabel.has(key)) byLabel.set(key, []);
    byLabel.get(key).push(n);
    if (n.type === "permission") {
      const nk = n.data.name.toLowerCase();
      if (!byLabel.has(nk)) byLabel.set(nk, []);
      byLabel.get(nk).push(n);
    }
  }
  const rank = { endpoint: 0, table: 1, permission: 2, file: 3, type: 4, area: 5, module: 6, screen: 7, routegroup: 8, layer: 9 };
  for (const w of words) {
    const hits = byLabel.get(w.toLowerCase()) ?? [];
    for (const n of hits.sort((a, b) => (rank[a.type] ?? 20) - (rank[b.type] ?? 20))) if (!out.includes(n.id)) out.push(n.id);
  }
  // Multi-word labels ("Order History", "Edit product prices").
  if (!out.length) {
    for (const [key, list] of byLabel) {
      if (key.length > 5 && key.includes(" ") && lower.includes(key.replace(/^#\d+\s/, ""))) for (const n of list) out.push(n.id);
    }
  }
  return out;
}

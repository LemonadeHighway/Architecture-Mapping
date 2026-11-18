// The right panel: details for whatever is selected (with every relationship's evidence), Health, Coverage and
// Recent work. Every file:line is a link that opens the source.
import { esc, icon, KIND_LABEL, TYPE_LABEL } from "./model.js";

let ctx = null; // { model, state, actions }

export function renderPanel(el, model, state, actions) {
  ctx = { model, state, actions };
  const tab = state.panelTab;
  const tabs = [["details", "Details"], ["health", `Health (${model.snap.findings.length})`], ["coverage", "Coverage"], ["changes", "Recent work"]];
  el.innerHTML = `<div class="ptabs">${tabs.map(([id, label]) => `<button data-tab="${id}" class="${tab === id ? "on" : ""}">${esc(label)}</button>`).join("")}</div><div id="pbody"></div>`;
  el.querySelectorAll(".ptabs button").forEach((b) => b.addEventListener("click", () => actions.setTab(b.dataset.tab)));
  const body = el.querySelector("#pbody");
  if (tab === "health") body.innerHTML = healthHtml(model);
  else if (tab === "coverage") body.innerHTML = coverageHtml(model);
  else if (tab === "changes") body.innerHTML = changesHtml(model, state);
  else if (state.selectedEdge) body.innerHTML = edgeHtml(model, state.selectedEdge);
  else if (state.selected && model.node(state.selected)) body.innerHTML = nodeHtml(model, state.selected);
  else body.innerHTML = viewHelpHtml(model, state);
  wire(body);
}

/** Every [data-go], [data-loc], [data-act] in the panel. */
function wire(root) {
  root.querySelectorAll("[data-go]").forEach((b) =>
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ctx.actions.goTo(b.dataset.go);
    }),
  );
  root.querySelectorAll("[data-loc]").forEach((b) =>
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const [file, line] = b.dataset.loc.split("|");
      ctx.actions.openSource(file, Number(line) || 1);
    }),
  );
  root.querySelectorAll("[data-explore]").forEach((b) => b.addEventListener("click", () => ctx.actions.explore(b.dataset.explore)));
  root.querySelectorAll("[data-copy]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        ctx.actions.toast("Copied to the clipboard.");
      } catch {
        ctx.actions.toast("Couldn't copy (the browser refused clipboard access).", true);
      }
    }),
  );
  root.querySelectorAll("[data-more]").forEach((b) =>
    b.addEventListener("click", () => {
      b.parentElement.querySelectorAll(".hidden-row").forEach((r) => r.classList.remove("hidden-row"));
      b.remove();
    }),
  );
  root.querySelectorAll("[data-finding]").forEach((b) => b.addEventListener("click", () => ctx.actions.showFinding(b.dataset.finding)));
}

const loc = (file, line, label) => (file ? `<button class="loc" data-loc="${esc(file)}|${line ?? 1}" title="Open the source">${esc(label ?? `${file}:${line ?? 1}`)}</button>` : "");
const dot = (s) => `<span class="dot ${esc(s)}" title="${esc(s)}"></span>`;
const section = (title, count, inner, open = false) => `<details ${open ? "open" : ""}><summary>${esc(title)} ${count !== null && count !== undefined ? `<span class="n">${count}</span>` : ""}</summary>${inner}</details>`;
const rowsLimited = (rows, limit = 12) => {
  if (rows.length <= limit) return `<div class="rows">${rows.join("")}</div>`;
  return `<div class="rows">${rows.slice(0, limit).join("")}${rows.slice(limit).map((r) => r.replace('class="row', 'class="row hidden-row')).join("")}<button class="btn" data-more>Show all ${rows.length}</button></div>`;
};

function header(model, id) {
  const n = model.node(id);
  const iconName = n.type === "layer" ? n.layer : n.type;
  const path = model.ancestors?.(id)?.filter((a) => a !== "system").reverse().map((a) => `<button class="loc" data-go="${esc(a)}" style="color:var(--muted);font-family:var(--font)">${esc(model.node(a)?.label ?? a)}</button>`).join(" / ") ?? "";
  return `<div class="phead"><span class="ico">${icon(iconName)}</span><div style="min-width:0"><div class="kind">${esc(TYPE_LABEL[n.type] ?? n.type)}${path ? ` · ${path}` : ""}</div><h2>${esc(n.label)}</h2></div></div>`;
}

function relationsHtml(model, id) {
  const outs = model.out(id);
  const ins = model.inc(id);
  const render = (list, dir) => {
    const byKind = new Map();
    for (const e of list) {
      if (!byKind.has(e.kind)) byKind.set(e.kind, []);
      byKind.get(e.kind).push(e);
    }
    return [...byKind].map(([kind, es]) => {
      const rows = es
        .sort((a, b) => (a.status === b.status ? 0 : a.status === "verified" ? -1 : 1))
        .map((e) => {
          const other = dir === "out" ? e.to : e.from;
          const on = model.node(other);
          const ev = e.evidence[0];
          return `<div class="row link" data-go="${esc(other)}">${dot(e.status)}<div class="main">${esc(on?.label ?? other)}${e.count > 1 ? ` <span class="faint">×${e.count}</span>` : ""}<div class="sub">${ev ? `${loc(ev.file, ev.line)} ${esc(ev.note ?? "")}` : ""}</div></div></div>`;
        });
      const title = dir === "out" ? `${KIND_LABEL[kind] ?? kind} →` : `← ${KIND_LABEL[kind] ?? kind} (by)`;
      return section(title, es.length, rowsLimited(rows, 8), es.length <= 6);
    }).join("");
  };
  if (!outs.length && !ins.length) return `<p class="muted" style="font-size:13px">No relationships found for this item itself. Explore inside to see its contents' relationships.</p>`;
  return `${render(outs, "out")}${render(ins, "in")}`;
}

function nodeHtml(model, id) {
  const n = model.node(id);
  let h = header(model, id);
  if (n.desc) h += `<p class="lead">${esc(n.desc)}</p>`;
  if (n.data?.descFrom) h += `<div class="src-note">Summary from ${loc(n.data.descFrom, 1)}</div>`;
  const kids = model.kids(id);
  h += `<div class="btn-row">`;
  if (kids.length || ["endpoint", "table", "permission", "role", "screen", "integration", "step", "type", "file"].includes(n.type)) h += `<button class="btn primary" data-explore="${esc(id)}">Explore ${kids.length ? "inside" : "connections"}</button>`;
  if (n.file) h += `<button class="btn" data-loc="${esc(n.file)}|${n.line ?? 1}">Open source</button>`;
  h += `</div>`;
  switch (n.type) {
    case "endpoint": h += endpointHtml(model, n); break;
    case "table": h += tableHtml(model, n); break;
    case "permission": h += permissionHtml(model, n); break;
    case "file": h += fileHtml(model, n); break;
    case "area": h += areaHtml(model, n); break;
    case "routegroup": h += routeGroupHtml(model, n); break;
    case "screen": h += `<dl class="kv"><dt>Route</dt><dd class="mono">#/${esc(n.data.route)}</dd><dt>Found by</dt><dd>${esc({ switch: "a switch-based router", "react-router": "a React Router <Route>", "route-object": "a route object", file: "file-based routing (Next.js)" }[n.data.kind] ?? n.data.kind ?? "")}</dd><dt>Renders</dt><dd>${esc(n.data.components.join(", "))}</dd><dt>Defined</dt><dd>${loc(n.file, n.line)}${n.data.nav ? `<br>${loc(n.data.nav.file, n.data.nav.line, `sidebar entry ${n.data.nav.file.split("/").pop()}:${n.data.nav.line}`)}` : ""}</dd><dt>Code reached</dt><dd>${n.data.filesReached ?? 0} files through imports</dd></dl>`; break;
    case "step": h += `<dl class="kv"><dt>Who</dt><dd>${esc(n.data.who)}</dd><dt>Defined</dt><dd>${loc(n.file, n.line)}</dd><dt>Keywords</dt><dd>${esc(n.data.keywords.join(", ") || "none")} <span class="faint">(.architecture-explorer.json, inferred)</span></dd></dl>`; break;
    case "type": h += `<dl class="kv"><dt>Kind</dt><dd>${esc(n.data.kind)}${n.data.partial ? " (partial)" : ""}</dd><dt>Namespace</dt><dd class="mono">${esc(n.data.namespace ?? "")}</dd>${n.data.bases?.length ? `<dt>Bases</dt><dd>${esc(n.data.bases.join(", "))}</dd>` : ""}<dt>Declared</dt><dd>${loc(n.file, n.line)}</dd></dl>`; break;
    case "layer": h += `<p class="muted" style="font-size:13px">${esc(n.data?.stats ?? "")}</p>`; break;
  }
  if (kids.length && !["area", "routegroup"].includes(n.type)) {
    const rows = kids.map((k) => {
      const kn = model.node(k);
      return `<div class="row link" data-go="${esc(k)}"><span class="dot"></span><div class="main">${esc(kn.label)}<div class="sub">${esc(TYPE_LABEL[kn.type] ?? kn.type)}${kn.desc ? ` · ${esc(kn.desc.slice(0, 110))}` : ""}</div></div></div>`;
    });
    h += section("Contents", kids.length, rowsLimited(rows, 10), kids.length <= 10);
  }
  if (!["area", "routegroup"].includes(n.type)) h += `<div style="margin-top:6px">${section("Relationships", model.out(id).length + model.inc(id).length, relationsHtml(model, id), true)}</div>`;
  return h;
}

const AUTH_TEXT = {
  anonymous: "Open to anyone, no sign-in (AllowAnonymous).",
  "permission-route": "Needs a permission, policy or role, checked before the handler runs (on the route, the group or the controller).",
  "no-auth-found": "No authorization found: no [Authorize], no RequireAuthorization, no fallback policy. ASP.NET Core leaves such an address open, unless middleware the scan can't see protects it.",
  "permission-route-computed": "Needs a permission given as a variable on the route.",
  "permission-handler": "Signed in, then the handler enforces a permission.",
  "permission-domain": "Signed in, then the business rules the handler calls enforce a permission.",
  "permission-handler-computed": "Signed in, then the code enforces a permission chosen at run time (a variable).",
  "permission-allows": "Signed in, then the code tests a permission, role or policy and branches: it refuses, or returns less, without it.",
  "role-handler": "Signed in, then the handler checks for company managers.",
  "signed-in": "Any signed-in user. No permission check found on the route, in the handler, or in what the handler calls.",
  unknown: "No sign-in rule found.",
};

function endpointHtml(model, n) {
  const a = n.data.auth ?? {};
  let h = `<dl class="kv"><dt>Address</dt><dd class="mono">${esc(n.data.verb)} ${esc(n.data.route)}</dd><dt>Mapped</dt><dd>${loc(n.file, n.line)}${n.data.helper ? ` <span class="faint">(through the helper at line ${n.data.helper.line})</span>` : ""}</dd>`;
  if (n.data.handler) h += `<dt>Handler</dt><dd>${n.data.handler.kind === "lambda" ? "inline lambda " : esc(n.data.handler.name ?? "") + " "}${n.data.handler.file ? loc(n.data.handler.file, n.data.handler.line) : `<span class="faint">not found</span>`}</dd>`;
  if (n.data.params?.length) h += `<dt>Parameters</dt><dd class="mono" style="font-size:11.5px">${n.data.params.map((p) => esc(`${p.type ?? "?"} ${p.name}`)).join("<br>")}</dd>`;
  h += `</dl>`;
  const authRows = [];
  if (a.anonymous) authRows.push(`<div class="row">${dot("verified")}<div class="main">AllowAnonymous<div class="sub">${loc(a.anonymous.file, a.anonymous.line)}</div></div></div>`);
  for (const p of a.routeAuth ?? []) {
    const target = p.kind === "policy" ? `perm:policy:${p.name}` : p.kind === "role" ? `role:${p.name}` : p.kind === "permission" && p.name ? `perm:${p.name}` : null;
    const what = p.kind === "signed-in" ? "Requires a signed-in user" : p.kind === "policy" ? `Policy ${p.name}` : p.kind === "role" ? `Role ${p.name}` : `Permission ${p.name ?? "(a variable)"}`;
    authRows.push(`<div class="row${target ? " link" : ""}" ${target ? `data-go="${esc(target)}"` : ""}>${dot("verified")}<div class="main">${esc(what)}${p.ownRecordPasses ? ' <span class="faint">(the guard\'s name suggests a person\'s own record passes without it)</span>' : ""}<div class="sub">${loc(p.file, p.line)} · ${esc(p.note ?? "")}</div></div></div>`);
  }
  for (const r of a.handlerRequires ?? []) authRows.push(`<div class="row${r.permission ? " link" : ""}" ${r.permission ? `data-go="perm:${esc(r.permission)}"` : ""}>${dot(r.inferred ? "inferred" : "verified")}<div class="main">Enforces ${esc(r.permission ?? `(${r.argText})`)}<div class="sub">${loc(r.file, r.line)} · ${esc(r.via)}${r.inferred ? " · a call in this chain was matched by method name" : ""}</div></div></div>`);
  for (const r of a.handlerAllows ?? []) {
    const target = r.permission ? `perm:${r.permission}` : r.policy ? `perm:policy:${r.policy}` : r.role ? `role:${r.role}` : null;
    authRows.push(`<div class="row${target ? " link" : ""}" ${target ? `data-go="${esc(target)}"` : ""}>${dot(r.inferred ? "inferred" : "verified")}<div class="main">Tests ${esc(r.permission ?? (r.role ? `role ${r.role}` : r.policy ? `policy ${r.policy}` : `(${r.argText})`))} <span class="faint">(branch)</span><div class="sub">${loc(r.file, r.line)} · ${esc(r.via)}</div></div></div>`);
  }
  if (a.fallback) authRows.push(`<div class="row">${dot("verified")}<div class="main">Sign-in by default (fallback policy)<div class="sub">${loc(a.fallback.file, a.fallback.line)}</div></div></div>`);
  h += section("Who may call it", authRows.length, `<p class="muted" style="font-size:13px;margin:8px 0">${esc(AUTH_TEXT[a.level] ?? "")}</p><div class="rows">${authRows.join("")}</div>`, true);
  if (n.data.prefixHops?.length) h += section("How the path is built", n.data.prefixHops.length, `<div class="rows">${n.data.prefixHops.map((p) => `<div class="row">${dot("verified")}<div class="main mono" style="font-size:12px">${esc(p.text)}<div class="sub">${loc(p.file, p.line)}</div></div></div>`).join("")}</div>`);
  return h;
}

function tableHtml(model, n) {
  const d = n.data;
  let h = `<dl class="kv"><dt>Created</dt><dd>${loc(d.created.file, d.created.line)}</dd><dt>Primary key</dt><dd class="mono">${esc((d.primaryKey ?? []).join(", ") || "—")}</dd><dt>Row security</dt><dd>${d.policies.length ? `enabled · ${d.policies.map((p) => `${esc(p.name)} ${loc(p.file, p.line)}`).join(", ")}` : d.dynamic.some((x) => x.policy) ? `set by a DO block ${loc(d.dynamic[0].file, d.dynamic[0].line)} (not analyzed)` : "no policy found"}</dd></dl>`;
  h += section("Columns", d.columns.length, `<table class="cols"><tr><th>Name</th><th>Type</th><th>Null</th></tr>${d.columns.map((c) => `<tr><td class="mono">${esc(c.name)}</td><td class="mono faint">${esc(c.type)}</td><td>${c.nullable ? "yes" : ""}</td></tr>`).join("")}</table>`, true);
  if (d.fks.length) h += section("Foreign keys", d.fks.length, `<div class="rows">${d.fks.map((f) => `<div class="row link" data-go="table:${esc(f.to)}">${dot(f.targetExists === false ? "unresolved" : "verified")}<div class="main mono" style="font-size:12px">(${esc(f.columns.join(", "))}) → ${esc(f.to)}${f.onDelete ? ` on delete ${esc(f.onDelete)}` : ""}<div class="sub">${loc(f.file, f.line)}</div></div></div>`).join("")}</div>`);
  if (d.triggers.length) h += section("Triggers", d.triggers.length, `<div class="rows">${d.triggers.map((t) => `<div class="row">${dot("verified")}<div class="main mono" style="font-size:12px">${esc(t.name)} → ${esc(t.fn)}()<div class="sub">${esc(t.timing)} · ${loc(t.file, t.line)}</div></div></div>`).join("")}</div>`);
  if (d.indexes.length) h += section("Indexes", d.indexes.length, `<div class="rows">${d.indexes.map((i) => `<div class="row"><span class="dot"></span><div class="main mono" style="font-size:12px">${esc(i.name ?? "(unnamed)")}${i.unique ? " unique" : ""} (${esc(i.columns)})<div class="sub">${loc(i.file, i.line)}</div></div></div>`).join("")}</div>`);
  h += section("History", d.history.length, `<div class="rows">${d.history.map((x) => `<div class="row"><span class="dot"></span><div class="main">${esc(x.what)}<div class="sub">${loc(x.file, x.line)}</div></div></div>`).join("")}</div>`);
  return h;
}

function permissionHtml(model, n) {
  const d = n.data;
  return `<dl class="kv"><dt>Kind</dt><dd>${esc(d.kind === "policy" ? "authorization policy" : d.kind === "enum" ? `enum member #${d.number}` : "name used in code")} <span class="mono faint">${esc(d.name)}</span>${d.undefinedPolicy ? ' <span style="color:var(--amber)">no AddPolicy found</span>' : ""}</dd><dt>Module</dt><dd>${esc(d.module ?? "—")}</dd><dt>Enum</dt><dd>${loc(n.file, n.line)}</dd><dt>Catalogue</dt><dd>${d.catalog ? loc(d.catalog.file, d.catalog.line) : `<span style="color:var(--red)">missing</span>`}</dd><dt>Screens' list</dt><dd>${d.inTypeScript ? loc(d.tsFile, d.inTypeScript.line) : d.tsFile ? `<span style="color:var(--red)">missing from ${esc(d.tsFile.split("/").pop())}</span>` : "—"}</dd></dl>`;
}

function fileHtml(model, n) {
  const d = n.data;
  let h = `<dl class="kv"><dt>Path</dt><dd class="mono" style="font-size:12px">${esc(n.file)}</dd><dt>Read by</dt><dd>${esc(d.scanner ?? "not analyzed")}${d.notAnalyzed ? ` (${esc(d.notAnalyzed)})` : ""}</dd>${d.lines ? `<dt>Lines</dt><dd>${d.lines}</dd>` : ""}${n.changed ? `<dt>Git</dt><dd style="color:var(--green)">${esc(n.changed)} (not committed)</dd>` : ""}${d.tests ? `<dt>Tests</dt><dd>${d.tests.methods} test methods</dd>` : ""}`;
  if (d.localUrls?.length) h += `<dt>Local links</dt><dd>${d.localUrls.map((u) => `${esc(u.url)} ${loc(n.file, u.line, `:${u.line}`)}`).join("<br>")}</dd>`;
  if (d.configSections?.length) h += `<dt>Config</dt><dd>${d.configSections.map((s) => `"${esc(s.name)}" ${loc(n.file, s.line, `:${s.line}`)}`).join(", ")}</dd>`;
  if (d.error) h += `<dt>Scan error</dt><dd style="color:var(--red)">${esc(d.error)}</dd>`;
  return h + `</dl>`;
}

function areaHtml(model, n) {
  const rows = n.kids.map((m) => `<div class="row link" data-go="${esc(m)}"><span class="dot"></span><div class="main">${esc(model.node(m)?.label)} <span class="faint">${esc(model.node(m)?.layer)}</span><div class="sub">${esc(n.data.reasons[m] ?? "")}</div></div></div>`);
  return section("Modules", n.kids.length, `<p class="muted" style="font-size:12.5px">Grouping is by folder name, and for web folders by the API they call most. It is a convention, not something the code declares.</p><div class="rows">${rows.join("")}</div>`, true);
}

function routeGroupHtml(model, n) {
  const rows = n.kids.map((k) => {
    const e = model.nodes[k];
    const lvl = e.data.auth?.level;
    const tone = lvl === "anonymous" || lvl === "unknown" ? "unresolved" : lvl === "signed-in" ? "inferred" : "verified";
    return `<div class="row link" data-go="${esc(k)}">${dot(tone)}<div class="main mono" style="font-size:12px">${esc(e.data.verb)} ${esc(e.data.route)}<div class="sub" style="font-family:var(--font)">${esc(e.desc ?? "")}</div></div></div>`;
  });
  return section("Addresses", n.kids.length, `<div class="rows">${rows.join("")}</div>`, true) + `<p class="faint" style="font-size:12px">Dot colour: blue = a permission is checked, amber = sign-in only, red = open or no rule found.</p>`;
}

function edgeHtml(model, de) {
  const from = model.node(de.from);
  const to = model.node(de.to);
  const list = de.edgeIdx.map((i) => model.edges[i]);
  let h = `<div class="phead"><span class="ico">${icon("endpoint")}</span><div><div class="kind">Relationship</div><h2>${esc(from?.label ?? de.from)} → ${esc(to?.label ?? de.to)}</h2></div></div>`;
  h += `<div class="sevline"><span>${dot("verified")} ${de.verified} verified</span><span>${dot("inferred")} ${de.inferred} inferred</span><span>${dot("unresolved")} ${de.unresolved} unresolved</span></div>`;
  h += `<p class="muted" style="font-size:13px">${[...de.kinds].map((k) => KIND_LABEL[k] ?? k).join(", ")} · ${de.count} occurrence${de.count > 1 ? "s" : ""} in all.</p>`;
  const rows = list.map((e) => {
    const ev = e.evidence ?? [];
    return `<div class="row">${dot(e.status)}<div class="main"><button class="loc" data-go="${esc(e.from)}" style="font-family:var(--font);color:var(--text)">${esc(model.node(e.from)?.label ?? e.from)}</button> <span class="faint">${esc(KIND_LABEL[e.kind] ?? e.kind)}</span> <button class="loc" data-go="${esc(e.to)}" style="font-family:var(--font);color:var(--text)">${esc(model.node(e.to)?.label ?? e.to)}</button>${ev.slice(0, 3).map((x) => `<div class="sub">${loc(x.file, x.line)} ${esc(x.note ?? "")}</div>`).join("")}${ev.length > 3 ? `<div class="sub">+${ev.length - 3} more places</div>` : ""}</div></div>`;
  });
  h += section("Evidence", list.length, rowsLimited(rows, 15), true);
  if (de.edgeIdx.length >= 400) h += `<p class="faint">Showing the first 400.</p>`;
  return h;
}

function healthHtml(model) {
  const f = model.snap.findings;
  const count = (s) => f.filter((x) => x.severity === s).length;
  let h = `<div class="phead"><span class="ico" style="color:var(--red)">${icon("workflow")}</span><div><div class="kind">Health check</div><h2>${count("important") + count("review")} things to look at</h2></div></div>`;
  h += `<p class="lead" style="font-size:13.5px">Found by reading the code, the migrations and the docs. Each one says what was found and where; whether it is a problem is your call.</p>`;
  h += `<div class="sevline"><span>${dot("important")} ${count("important")} important</span><span>${dot("review")} ${count("review")} review</span><span>${dot("minor")} ${count("minor")} minor</span><span>${dot("info")} ${count("info")} info</span></div>`;
  for (const x of f) {
    const ev = x.evidence.map((e) => `<div class="row${e.node ? " link" : ""}" ${e.node ? `data-go="${esc(e.node)}"` : ""}><span class="dot"></span><div class="main">${esc(e.note ?? "")}<div class="sub">${loc(e.file, e.line)}</div></div></div>`);
    const prompt = `In this repository, ${x.title.charAt(0).toLowerCase()}${x.title.slice(1)}. ${x.detail}\n\nPlaces:\n${x.evidence.slice(0, 25).map((e) => `- ${e.file}:${e.line} ${e.note ?? ""}`).join("\n")}\n\nLook at each place, tell me which ones are real problems, and propose fixes before changing anything.`;
    h += `<div class="finding"><h4>${dot(x.severity)}<span>${esc(x.title)}</span></h4><p>${esc(x.detail)}</p>${ev.length ? section("Where", ev.length, rowsLimited(ev, 6)) : ""}<div class="btn-row" style="margin-bottom:0">${x.evidence.length ? `<button class="btn" data-finding="${esc(x.id)}">Show on map</button>` : ""}<button class="btn" data-copy="${esc(prompt)}">Copy prompt for Claude Code</button></div></div>`;
  }
  if (!f.length) h += `<div class="empty">No findings.</div>`;
  return h;
}

function coverageHtml(model) {
  const c = model.snap.coverage;
  const e = c.edges;
  const total = e.verified + e.inferred + e.unresolved || 1;
  let h = `<div class="phead"><span class="ico" style="color:var(--green)">${icon("security")}</span><div><div class="kind">Scanning coverage</div><h2>What was read, and how sure</h2></div></div>`;
  h += `<p class="lead" style="font-size:13.5px">${c.files.analyzed} of ${c.files.total} files read by a scanner (${Object.entries(c.files.byScanner).map(([k, v]) => `${v} ${k}`).join(", ")}). Scanned ${new Date(model.snap.scannedAt).toLocaleTimeString()} in ${model.snap.durationMs} ms.</p>`;
  h += `<div style="font-weight:600;margin-top:6px">Relationships</div><div class="statbar"><span class="v" style="width:${(100 * e.verified) / total}%"></span><span class="i" style="width:${(100 * e.inferred) / total}%"></span><span class="u" style="width:${(100 * e.unresolved) / total}%"></span></div><div class="sevline"><span>${dot("verified")} ${e.verified} verified</span><span>${dot("inferred")} ${e.inferred} inferred</span><span>${dot("unresolved")} ${e.unresolved} unresolved</span></div>`;
  h += section("By kind", Object.keys(e.byKind).length, `<table class="cols"><tr><th>Kind</th><th>Verified</th><th>Inferred</th><th>Unres.</th></tr>${Object.entries(e.byKind).sort((a, b) => b[1].verified + b[1].inferred - a[1].verified - a[1].inferred).map(([k, v]) => `<tr><td>${esc(KIND_LABEL[k] ?? k)}</td><td>${v.verified}</td><td>${v.inferred}</td><td>${v.unresolved}</td></tr>`).join("")}</table>`);
  h += `<div style="font-weight:600;margin:14px 0 8px">Raw matches against what was understood</div>`;
  for (const r of c.rows) {
    const pct = r.raw ? Math.min(100, (100 * Math.min(r.matched, r.raw)) / r.raw) : 100;
    const left = r.raw ? Math.max(0, (100 * r.left) / r.raw) : 0;
    const lo = (r.leftovers ?? []).map((x) => `<div class="row"><span class="dot"></span><div class="main">${esc(x.what)}<div class="sub">${loc(x.file, x.line)}</div></div></div>`);
    h += `<div class="cov-row"><div class="top"><span>${esc(r.area)}</span><span class="nums">raw ${r.raw} · understood ${r.matched} · left ${r.left}</span></div><div class="bar"><span style="width:${pct}%"></span><span class="left" style="width:${left}%"></span></div><p>${esc(r.detail)}</p>${lo.length ? section("Listed, not linked", lo.length, rowsLimited(lo, 6)) : ""}</div>`;
  }
  for (const x of c.crossChecks) {
    h += `<div class="cov-row"><div class="top"><span>Cross-check: ${esc(x.name)}</span><span class="nums" style="color:${x.agree ? "var(--green)" : "var(--red)"}">${x.agree ? "agrees" : "disagrees"}</span></div><p>The project's own test lists how many addresses each permission guards. The explorer counted them independently. ${loc(x.file, x.line)}</p>${section("Rows", x.rows.length, `<table class="cols"><tr><th>Permission</th><th>Test</th><th>Scanned</th></tr>${x.rows.map((r) => `<tr><td>${esc(r.permission)}</td><td>${r.expected ?? "—"}</td><td style="color:${r.expected === r.scanned ? "inherit" : "var(--red)"}">${r.scanned}</td></tr>`).join("")}</table>`)}</div>`;
  }
  h += section("What this scan can't see", c.limits.length, `<ul class="plain">${c.limits.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`, true);
  h += section("Files not analyzed", c.files.notAnalyzed.length, rowsLimited(c.files.notAnalyzed.map((x) => `<div class="row"><span class="dot"></span><div class="main mono" style="font-size:12px">${esc(x.path)}<div class="sub" style="font-family:var(--font)">${esc(x.reason)}</div></div></div>`), 8));
  if (c.files.errors.length) h += section("Scan errors", c.files.errors.length, `<div class="rows">${c.files.errors.map((x) => `<div class="row">${dot("unresolved")}<div class="main">${esc(x.path)}<div class="sub">${esc(x.error)}</div></div></div>`).join("")}</div>`, true);
  h += `<p class="faint" style="font-size:12px">Parsers: TypeScript ${esc(model.snap.meta.typescript)} (from web/node_modules), C# and SQL readers built into the explorer. Node ${esc(model.snap.meta.node)}.</p>`;
  return h;
}

function changesHtml(model, state) {
  const g = model.snap.git;
  let h = `<div class="phead"><span class="ico" style="color:var(--green)">${icon("workflow")}</span><div><div class="kind">Recent work</div><h2>${g.changed.length} uncommitted change${g.changed.length === 1 ? "" : "s"}</h2></div></div>`;
  h += `<dl class="kv"><dt>Branch</dt><dd class="mono">${esc(g.branch ?? "?")}</dd><dt>Last commit</dt><dd>${esc(g.lastCommit ?? "?")}</dd><dt>Map</dt><dd><span class="live ${state.live ? "" : "off"}">${state.live ? "live, updates as files change" : "reconnecting…"}</span></dd></dl>`;
  if (state.updates.length) {
    h += section("Updates this session", state.updates.length, `<div class="rows">${state.updates.map((u) => `<div class="row"><span class="dot verified"></span><div class="main">${esc(u.time)} · ${u.files.length} file${u.files.length === 1 ? "" : "s"}<div class="sub">${u.files.slice(0, 6).map((f) => (model.nodes[`file:${f.path}`] ? `<button class="loc" data-go="file:${esc(f.path)}">${esc(f.path)}</button>` : esc(`${f.path} (${f.change})`))).join("<br>")}</div></div></div>`).join("")}</div>`, true);
  }
  const byModule = new Map();
  for (const c of g.changed) {
    const fileId = `file:${c.path}`;
    const mod = model.nodes[fileId] ? model.moduleOf(fileId) : null;
    const key = mod ? model.nodes[mod].label + ` (${model.nodes[mod].layer})` : "Other";
    if (!byModule.has(key)) byModule.set(key, []);
    byModule.get(key).push(c);
  }
  for (const [key, list] of [...byModule].sort((a, b) => b[1].length - a[1].length)) {
    h += section(key, list.length, `<div class="rows">${list.map((c) => `<div class="row${model.nodes[`file:${c.path}`] ? " link" : ""}" ${model.nodes[`file:${c.path}`] ? `data-go="file:${esc(c.path)}"` : ""}><span class="dot" style="background:${c.status === "new" ? "var(--green)" : c.status === "deleted" ? "var(--red)" : "var(--amber)"}"></span><div class="main mono" style="font-size:12px">${esc(c.path)}<div class="sub" style="font-family:var(--font)">${esc(c.status)}</div></div></div>`).join("")}</div>`, list.length <= 6);
  }
  if (!g.changed.length) h += `<div class="empty">Nothing uncommitted.</div>`;
  return h;
}

function viewHelpHtml(model, state) {
  const s = model.snap;
  const eps = Object.values(s.nodes).filter((n) => n.type === "endpoint").length;
  let h = `<div class="phead"><span class="ico">${icon("system")}</span><div><div class="kind">Start here</div><h2>How to read this map</h2></div></div>`;
  h += `<ul class="plain" style="font-size:13.5px;color:#cfcfd6"><li><b>Click</b> a box for its details and every relationship with its source line. <b>Double-click</b> (or Explore) to go inside: what uses it on the left, its contents in the middle, what it uses on the right.</li><li><b>Click a line</b> to see the code behind it. Solid = verified (a literal fact in the code), dashed amber = inferred (a name match or a convention), dotted red = unresolved.</li><li>Drag to move, scroll to zoom, <kbd>/</kbd> to search, <kbd>Esc</kbd> to clear, <kbd>Alt</kbd>+<kbd>←</kbd> to go back.</li><li>The map rescans by itself when files change; changed boxes get a green edge.</li></ul>`;
  h += `<dl class="kv"><dt>Scanned</dt><dd>${s.meta.files} files · ${eps} API addresses · ${Object.values(s.nodes).filter((n) => n.type === "table").length} tables</dd><dt>Relationships</dt><dd>${s.coverage.edges.verified} verified · ${s.coverage.edges.inferred} inferred · ${s.coverage.edges.unresolved} unresolved</dd><dt>Branch</dt><dd class="mono">${esc(s.git.branch ?? "?")}</dd></dl>`;
  if (state.view === "workflow" && s.statusEnums?.length) {
    h += section("Status models in the code", s.statusEnums.length, `<div class="rows">${s.statusEnums.map((e) => `<div class="row"><span class="dot verified"></span><div class="main">${esc(e.name)}: ${esc(e.members.map((m) => m.name).join(" · "))}<div class="sub">${loc(e.file, e.line)}</div></div></div>`).join("")}</div>`, true);
  }
  if (!s.config?.source) h += `<p class="muted" style="font-size:12.5px">No .architecture-explorer.json in this repository: everything shown was auto-detected. A config adds the project's own permission conventions and business workflow (ask Claude to set one up).</p>`;
  else if (s.config.error) h += `<p style="font-size:12.5px;color:var(--red)">${esc(s.config.error)}</p>`;
  return h;
}

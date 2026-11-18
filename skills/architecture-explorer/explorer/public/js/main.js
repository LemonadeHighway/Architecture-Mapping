// The explorer page: loads the scan, keeps the UI state (view, drill-down, selection, filters) in the address bar,
// listens for live updates, and wires the top bar, search, flows and the prompt bar.
import { buildModel, KIND_GROUPS, TYPE_LABEL, icon, esc } from "./model.js";
import { VIEWS, buildView, deriveSynthetic } from "./views.js";
import { createCanvas } from "./canvas.js";
import { renderPanel } from "./panel.js";
import { answer } from "./ask.js";
import { openSource } from "./source.js";

const $ = (id) => document.getElementById(id);
const state = {
  view: "overview",
  focus: null,
  selected: null,
  selDisplay: null,
  selectedEdge: null,
  panelTab: "details",
  panelOpen: true,
  kindGroups: Object.fromEntries(KIND_GROUPS.map((g) => [g.id, !g.off])),
  statuses: { verified: true, inferred: true, unresolved: true },
  expanded: new Set([""]),
  live: false,
  updates: [],
  tour: null,
  filtersOpen: false,
};
let model = null;
let spec = null;
const navStack = [];
let flash = new Set();

const canvas = createCanvas($("canvas"), {
  onSelect: (dn) => {
    if (dn.dir) return toggleDir(dn.dir.path);
    select(dn.node ?? dn.id, dn.id);
  },
  onOpen: (dn) => {
    if (dn.dir) return toggleDir(dn.dir.path);
    if (dn.drill) explore(dn.node ?? dn.id);
  },
  onEdge: (de) => {
    state.selectedEdge = de;
    state.selected = null;
    state.selDisplay = null;
    state.panelTab = "details";
    openPanel();
    canvas.setSelection(null, de.id);
    drawPanel();
  },
  onBackground: () => {
    if (!state.selected && !state.selectedEdge) return;
    state.selected = null;
    state.selDisplay = null;
    state.selectedEdge = null;
    canvas.setSelection(null, null);
    drawPanel();
    writeHash();
  },
});

// ---------- loading ----------
async function load(first = false) {
  if (first) showState("loading");
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const r = await fetch("/api/graph", { cache: "no-store" });
      if (r.status === 503) {
        await new Promise((res) => setTimeout(res, 1000));
        continue;
      }
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const snap = await r.json();
      model = buildModel(snap);
      deriveSynthetic(model);
      showState(null);
      return true;
    } catch (e) {
      if (attempt > 2) {
        showState("error", e.message);
        return false;
      }
      await new Promise((res) => setTimeout(res, 800));
    }
  }
  showState("error", "The scan is taking too long.");
  return false;
}

function showState(kind, message) {
  document.querySelector(".state-center")?.remove();
  if (!kind) return;
  const box = document.createElement("div");
  box.className = "state-center";
  box.innerHTML = kind === "loading"
    ? `<div class="state-box"><div class="skeleton" style="width:340px;height:16px;margin-bottom:12px"></div><div class="skeleton" style="width:260px;height:16px;margin:0 auto 12px"></div><div class="muted">Scanning the repository…</div></div>`
    : `<div class="state-box"><h3 style="margin-top:0">Couldn't load the map</h3><p class="muted">${esc(message ?? "")}</p><p class="muted" style="font-size:12.5px">Is the explorer server still running? Start it again from Claude Code ("open the architecture explorer"), or run its server.mjs.</p><button class="btn primary" id="retry">Try again</button></div>`;
  $("canvas-wrap").appendChild(box);
  box.querySelector("#retry")?.addEventListener("click", async () => {
    if (await load(true)) renderAll(true);
  });
}

// ---------- live updates ----------
function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("hello", () => setLive(true));
  es.addEventListener("update", async (ev) => {
    const info = JSON.parse(ev.data);
    if (!(await load())) return;
    flash = new Set();
    for (const c of info.changedFiles) {
      const id = `file:${c.path}`;
      if (!model.nodes[id]) continue;
      for (const a of [id, ...model.ancestors(id), ...model.descendants(id)]) flash.add(a);
      const area = model.areaOf(model.moduleOf(id));
      if (area) flash.add(area.id);
    }
    state.updates.unshift({ time: new Date().toLocaleTimeString(), files: info.changedFiles });
    state.updates = state.updates.slice(0, 20);
    const names = info.changedFiles.slice(0, 3).map((c) => c.path.split("/").pop()).join(", ");
    toast(info.changedFiles.length ? `Map updated: ${names}${info.changedFiles.length > 3 ? ` and ${info.changedFiles.length - 3} more` : ""} (${info.durationMs} ms)` : "Map updated (git status).");
    renderAll(false);
    flash = new Set();
  });
  es.addEventListener("scan-error", (ev) => toast(`Scan failed: ${JSON.parse(ev.data).message}. Showing the last good map.`, true));
  es.onerror = () => setLive(false);
}
function setLive(v) {
  state.live = v;
  if (model) drawLegend();
  if (state.panelTab === "changes" && model) drawPanel();
}

// ---------- rendering ----------
function renderAll(resetCamera) {
  if (!model) return;
  spec = buildView(model, state);
  drawViewbar();
  drawHead();
  drawCrumbs();
  drawFilters();
  drawLegend();
  if (!spec.columns.length && !spec.positioned?.length) {
    canvas.render({ ...spec, columns: [], edges: [] });
  } else if (spec.columns.length && spec.columns.every((c) => !c.nodes.length)) {
    canvas.render(spec);
    toast("Nothing to show here with the current relationship filters.", true);
  } else canvas.render(spec, { selectedId: state.selDisplay ?? state.selected, selectedEdgeId: state.selectedEdge?.id, flash });
  $("health-count").textContent = String(model.snap.findings.filter((f) => f.severity === "important" || f.severity === "review").length);
  $("changes-count").textContent = String(model.snap.git.changed.length);
  $("repo-name").textContent = model.snap.title ?? model.snap.repoName;
  document.title = `${model.snap.title ?? model.snap.repoName} · Architecture`;
  $("ask-input").placeholder = `Ask about ${model.snap.title ?? model.snap.repoName}… e.g. who calls /api/orders · what does OrderStore use · which addresses are open`;
  drawPanel();
  drawTour();
  writeHash();
}

function drawPanel() {
  const panel = $("panel");
  panel.hidden = !state.panelOpen;
  for (const b of document.querySelectorAll(".top-btn[data-tab]")) b.classList.toggle("on", state.panelOpen && state.panelTab === b.dataset.tab);
  if (!state.panelOpen || !model) return;
  renderPanel(panel, model, state, actions);
}

function drawViewbar() {
  $("viewbar").innerHTML = VIEWS.map((v) => `<button role="tab" data-view="${v.id}" class="${!state.focus && state.view === v.id ? "on" : ""}" aria-selected="${!state.focus && state.view === v.id}"><span style="width:15px;height:15px;display:inline-block">${icon(v.icon)}</span>${esc(v.label)}</button>`).join("");
  $("viewbar").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
}

function drawHead() {
  const s = spec;
  $("view-head").innerHTML = `<div class="eyebrow">${esc(s.eyebrow ?? "")}</div><h1>${esc(s.title ?? "")}</h1>${s.description ? `<p>${esc(s.description)}</p>` : ""}${s.descSource ? `<div class="src"><button data-loc="${esc(s.descSource.file)}|${s.descSource.line}">${esc(s.descSource.label)}</button></div>` : ""}${s.groupedLevel ? `<div class="src">Neighbours grouped by ${s.groupedLevel === 1 ? "module" : "layer"} (there are many). Explore one to see its files.</div>` : ""}`;
  $("view-head").querySelector("[data-loc]")?.addEventListener("click", (ev) => {
    const [f, l] = ev.currentTarget.dataset.loc.split("|");
    actions.openSource(f, Number(l));
  });
}

function drawCrumbs() {
  const view = VIEWS.find((v) => v.id === state.view);
  const parts = [`<button data-crumb="view" class="${state.focus ? "" : "current"}">${esc(view?.label ?? "Overview")}</button>`];
  if (state.focus) {
    const chain = [...model.ancestors(state.focus)].filter((a) => a !== "system").reverse();
    for (const a of chain) parts.push(`<span class="sep">/</span><button data-crumb="${esc(a)}">${esc(model.node(a)?.label ?? a)}</button>`);
    parts.push(`<span class="sep">/</span><button class="current" data-crumb="${esc(state.focus)}">${esc(model.node(state.focus)?.label ?? state.focus)}</button>`);
  }
  $("crumbs").innerHTML = parts.join("");
  $("crumbs").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => (b.dataset.crumb === "view" ? setView(state.view) : explore(b.dataset.crumb))));
  $("back").disabled = navStack.length === 0;
}

function drawFilters() {
  const f = $("filters");
  const on = KIND_GROUPS.filter((g) => state.kindGroups[g.id]).length;
  f.innerHTML = `${state.filtersOpen ? `<div class="fpanel"><div class="fsec">Relationship types</div>${KIND_GROUPS.map((g) => `<label><input type="checkbox" data-kg="${g.id}" ${state.kindGroups[g.id] ? "checked" : ""}> ${esc(g.label)}</label>`).join("")}<div class="fsec">Confidence</div>${["verified", "inferred", "unresolved"].map((s) => `<label><input type="checkbox" data-st="${s}" ${state.statuses[s] ? "checked" : ""}> <span class="dot ${s}" style="display:inline-block"></span> ${s}</label>`).join("")}</div>` : ""}<button id="filters-toggle">Relationships · ${on}/${KIND_GROUPS.length} types ${state.filtersOpen ? "▾" : "▸"}</button>`;
  f.querySelector("#filters-toggle").onclick = () => {
    state.filtersOpen = !state.filtersOpen;
    drawFilters();
  };
  f.querySelectorAll("[data-kg]").forEach((c) => (c.onchange = () => {
    state.kindGroups[c.dataset.kg] = c.checked;
    renderAll(false);
  }));
  f.querySelectorAll("[data-st]").forEach((c) => (c.onchange = () => {
    state.statuses[c.dataset.st] = c.checked;
    renderAll(false);
  }));
}

function drawLegend() {
  $("legend").innerHTML = `<span><i></i>verified</span><span><i class="inf"></i>inferred</span><span><i class="unr"></i>unresolved</span><span class="live ${state.live ? "" : "off"}">${state.live ? "live" : "offline"}</span>`;
}

// ---------- navigation ----------
function snapshotNav() {
  return { view: state.view, focus: state.focus, selected: state.selected, selDisplay: state.selDisplay };
}
function setView(id) {
  navStack.push(snapshotNav());
  state.view = id;
  state.focus = null;
  state.selected = null;
  state.selDisplay = null;
  state.selectedEdge = null;
  if (id !== "workflow") state.tour = null;
  renderAll(true);
}
function explore(id) {
  if (!model.node(id)) return;
  navStack.push(snapshotNav());
  state.focus = id;
  state.selected = id;
  state.selDisplay = null;
  state.selectedEdge = null;
  state.panelTab = "details";
  renderAll(true);
}
function back() {
  const prev = navStack.pop();
  if (!prev) return;
  Object.assign(state, prev, { selectedEdge: null });
  renderAll(true);
}
function select(nodeId, displayId) {
  state.selected = nodeId;
  state.selDisplay = displayId ?? nodeId;
  state.selectedEdge = null;
  state.panelTab = "details";
  openPanel();
  canvas.setSelection(state.selDisplay, null);
  drawPanel();
  writeHash();
}
/** Select a node anywhere: if it is drawn in the current view, select it there; otherwise open its parent. */
function goTo(id) {
  if (!model.node(id)) return;
  if (canvas.has(id)) {
    select(id);
    canvas.centerOn(id);
    return;
  }
  const n = model.node(id);
  const parent = n.parent && n.parent !== "system" ? n.parent : null;
  navStack.push(snapshotNav());
  state.focus = parent ?? id;
  state.selected = id;
  state.selDisplay = id;
  state.selectedEdge = null;
  state.panelTab = "details";
  openPanel();
  renderAll(true);
  if (canvas.has(id)) canvas.centerOn(id);
}
function toggleDir(path) {
  if (state.expanded.has(path)) state.expanded.delete(path);
  else state.expanded.add(path);
  renderAll(false);
}
function openPanel() {
  state.panelOpen = true;
  $("panel").hidden = false;
}

const actions = {
  goTo,
  explore,
  setTab: (t) => {
    state.panelTab = t;
    drawPanel();
  },
  openSource: (file, line) => openSource($("source-modal"), file, line, toast),
  toast,
  showFinding: (fid) => {
    const f = model.snap.findings.find((x) => x.id === fid);
    const first = f?.evidence.find((e) => e.node && model.node(e.node)) ?? f?.evidence.find((e) => model.nodes[`file:${e.file}`]);
    if (!first) return toast("Nothing on the map for this one.", true);
    state.panelTab = "details";
    goTo(first.node ?? `file:${first.file}`);
  },
};

function toast(text, err = false) {
  const t = document.createElement("div");
  t.className = `toast${err ? " err" : ""}`;
  t.textContent = text;
  $("toasts").appendChild(t);
  setTimeout(() => t.remove(), err ? 6000 : 3800);
}

// ---------- address bar ----------
function writeHash() {
  const p = new URLSearchParams();
  p.set("v", state.view);
  if (state.focus) p.set("f", state.focus);
  if (state.selected) p.set("s", state.selected);
  const h = `#${p.toString()}`;
  if (location.hash !== h) window.history.replaceState(null, "", h);
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (VIEWS.some((v) => v.id === p.get("v"))) state.view = p.get("v");
  state.focus = p.get("f");
  state.selected = p.get("s");
  state.selDisplay = state.selected;
}

// ---------- search ----------
const searchBox = $("search");
const results = $("search-results");
let active = 0;
let current = [];
searchBox.addEventListener("input", () => runSearch(searchBox.value));
searchBox.addEventListener("focus", () => searchBox.value && runSearch(searchBox.value));
searchBox.addEventListener("keydown", (ev) => {
  if (ev.key === "ArrowDown") {
    active = Math.min(current.length - 1, active + 1);
    paintResults();
    ev.preventDefault();
  } else if (ev.key === "ArrowUp") {
    active = Math.max(0, active - 1);
    paintResults();
    ev.preventDefault();
  } else if (ev.key === "Enter") {
    const r = current[active];
    if (r) pick(r);
  } else if (ev.key === "Escape") {
    results.hidden = true;
    searchBox.blur();
  }
});
document.addEventListener("click", (ev) => {
  if (!$("search-wrap").contains(ev.target)) results.hidden = true;
});
function runSearch(q) {
  q = q.trim().toLowerCase();
  if (!model || q.length < 2) {
    results.hidden = true;
    return;
  }
  const terms = q.split(/\s+/);
  const scored = [];
  for (const n of [...Object.values(model.nodes), ...model.synth.values()]) {
    const hay = `${n.label} ${n.file ?? ""} ${n.data?.route ?? ""} ${n.data?.name ?? ""} ${n.type}`.toLowerCase();
    if (!terms.every((t) => hay.includes(t))) continue;
    const label = (n.label ?? "").toLowerCase();
    let score = label === q ? 0 : label.startsWith(q) ? 1 : label.includes(q) ? 2 : 3;
    score += { endpoint: 0, file: 0.2, table: 0.1, permission: 0.1, screen: 0.1, module: 0.3, area: 0.3, routegroup: 0.4, type: 0.5 }[n.type] ?? 0.6;
    scored.push({ n, score });
  }
  scored.sort((a, b) => a.score - b.score || a.n.label.length - b.n.label.length);
  current = scored.slice(0, 40).map((x) => x.n);
  current.push({ id: "__code", label: `Search the code for "${q}"`, type: "code" });
  active = 0;
  paintResults();
}
function paintResults() {
  const groups = new Map();
  current.forEach((n, i) => {
    const g = n.type === "code" ? "Text search" : TYPE_LABEL[n.type] ?? n.type;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ n, i });
  });
  results.innerHTML = [...groups].map(([g, list]) => `<div class="sr-group">${esc(g)}</div>${list.map(({ n, i }) => `<div class="sr-item${i === active ? " active" : ""}" data-i="${i}" role="option"><span class="t">${esc(n.label)}</span><span class="s">${esc(n.type === "endpoint" ? n.file ?? "" : n.file ?? n.desc ?? "")}</span></div>`).join("")}`).join("");
  results.hidden = false;
  results.querySelectorAll(".sr-item").forEach((el) => el.addEventListener("click", () => pick(current[Number(el.dataset.i)])));
}
function pick(n) {
  results.hidden = true;
  if (n.id === "__code") return ask(searchBox.value);
  searchBox.value = "";
  goTo(n.id);
}

// ---------- ask ----------
$("ask").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const q = $("ask-input").value.trim();
  if (q) ask(q);
});
async function ask(q) {
  const box = $("ask-answer");
  box.hidden = false;
  box.innerHTML = `<div class="skeleton" style="height:14px;width:50%;margin-bottom:10px"></div><div class="skeleton" style="height:12px;width:80%"></div>`;
  try {
    const a = await answer(q, model);
    box.innerHTML = `<h3>${esc(a.title)}</h3>${a.text ? `<p>${esc(a.text)}</p>` : ""}<div class="rows">${a.items.map((it, i) => `<div class="row${it.id || it.file ? " link" : ""}" data-i="${i}"><span class="dot ${it.status ?? ""}"></span><div class="main">${esc(it.label)}<div class="sub">${esc(it.sub ?? "")}</div></div></div>`).join("")}</div><div class="actions"><button class="btn" id="ask-copy">Copy as a Claude Code prompt</button><button class="btn" id="ask-close">Close</button></div><div class="note">Answered from the scan index and a text search of the repository — no AI, nothing leaves this computer.</div>`;
    box.querySelectorAll(".row.link").forEach((r) => r.addEventListener("click", () => {
      const it = a.items[Number(r.dataset.i)];
      if (it.id && model.node(it.id)) goTo(it.id);
      else if (it.file) actions.openSource(it.file, it.line ?? 1);
    }));
    box.querySelector("#ask-close").onclick = () => (box.hidden = true);
    box.querySelector("#ask-copy").onclick = async () => {
      try {
        await navigator.clipboard.writeText(a.prompt);
        toast("Prompt copied.");
      } catch {
        toast("Couldn't copy.", true);
      }
    };
  } catch (e) {
    box.innerHTML = `<h3>Couldn't answer</h3><p>${esc(e.message)}</p>`;
  }
}

// ---------- flows (tour of the workflow) ----------
$("btn-flow").addEventListener("click", () => {
  if (state.view !== "workflow" || state.focus) setView("workflow");
  state.tour = { i: 0 };
  tourStep();
});
function tourSteps() {
  return Object.values(model.nodes).filter((n) => n.type === "step").sort((a, b) => a.data.number - b.data.number);
}
function tourStep() {
  const steps = tourSteps();
  if (!steps.length) {
    state.tour = null;
    toast("No workflow steps were found in the rule file.", true);
    return drawTour();
  }
  const s = steps[state.tour.i];
  select(s.id);
  canvas.centerOn(s.id);
  drawTour();
}
function drawTour() {
  const el = $("tour");
  if (!state.tour || state.view !== "workflow" || state.focus) {
    el.hidden = true;
    $("view-head").style.visibility = "";
    return;
  }
  const steps = tourSteps();
  const s = steps[state.tour.i];
  const mods = model.out(s.id).filter((e) => e.kind === "step-in").map((e) => `${model.node(e.to)?.label} (${model.node(e.to)?.layer})`);
  el.hidden = false;
  $("view-head").style.visibility = "hidden";
  el.innerHTML = `<div class="tt"><div class="k">Workflow · step ${state.tour.i + 1} of ${steps.length}${s.data.who ? ` · ${esc(s.data.who)}` : ""}</div><div class="h">${esc(s.label)}</div><div class="d">${esc(s.desc)}${mods.length ? ` — code: ${esc([...new Set(mods)].slice(0, 6).join(", "))}${mods.length > 6 ? "…" : ""} (inferred)` : " — no code matched yet"}${s.data.note ? ` · ${esc(s.data.note)}` : ""}</div><div class="bars">${steps.map((_, i) => `<span class="${i <= state.tour.i ? "on" : ""}"></span>`).join("")}</div></div><button class="icon-btn" id="tour-prev" aria-label="Previous step">‹</button><button class="icon-btn" id="tour-next" aria-label="Next step">›</button><button class="icon-btn" id="tour-close" aria-label="Close">✕</button>`;
  el.querySelector("#tour-prev").onclick = () => {
    state.tour.i = Math.max(0, state.tour.i - 1);
    tourStep();
  };
  el.querySelector("#tour-next").onclick = () => {
    state.tour.i = Math.min(steps.length - 1, state.tour.i + 1);
    tourStep();
  };
  el.querySelector("#tour-close").onclick = () => {
    state.tour = null;
    drawTour();
  };
}

// ---------- top bar and keys ----------
for (const b of document.querySelectorAll(".top-btn[data-tab]")) {
  b.addEventListener("click", () => {
    if (state.panelOpen && state.panelTab === b.dataset.tab) state.panelOpen = false;
    else {
      state.panelOpen = true;
      state.panelTab = b.dataset.tab;
    }
    drawPanel();
  });
}
$("btn-panel").onclick = () => {
  state.panelOpen = !state.panelOpen;
  drawPanel();
};
$("back").onclick = back;
$("zoom-in").onclick = () => canvas.zoomIn();
$("zoom-out").onclick = () => canvas.zoomOut();
$("zoom-fit").onclick = () => canvas.fit();
document.addEventListener("keydown", (ev) => {
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName ?? "");
  if (ev.key === "/" && !typing) {
    ev.preventDefault();
    searchBox.focus();
  } else if (ev.altKey && ev.key === "ArrowLeft") {
    ev.preventDefault();
    back();
  } else if (typing || !$("source-modal").hidden) {
    return;
  } else if (ev.key === "Escape") {
    if (!$("ask-answer").hidden) $("ask-answer").hidden = true;
    else if (state.tour) {
      state.tour = null;
      drawTour();
    } else if (state.selected || state.selectedEdge) {
      state.selected = state.selDisplay = state.selectedEdge = null;
      canvas.setSelection(null, null);
      drawPanel();
    } else if (state.focus) back();
  } else if (ev.key === "+" || ev.key === "=") canvas.zoomIn();
  else if (ev.key === "-") canvas.zoomOut();
  else if (ev.key === "0") canvas.fit();
  else if (ev.key === "ArrowLeft") canvas.pan(60, 0);
  else if (ev.key === "ArrowRight") canvas.pan(-60, 0);
  else if (ev.key === "ArrowUp") canvas.pan(0, 60);
  else if (ev.key === "ArrowDown") canvas.pan(0, -60);
  else if (ev.key === "Enter" && state.selected) explore(state.selected);
});
window.addEventListener("resize", () => canvas.fit());

// ---------- start ----------
readHash();
if (await load(true)) {
  if (state.focus && !model.node(state.focus)) state.focus = null;
  renderAll(true);
}
connect();

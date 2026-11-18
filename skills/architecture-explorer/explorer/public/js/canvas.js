// Draws a view spec: lays nodes out in columns (or uses given positions), routes edges between card sides, and
// handles pan, zoom, hover highlighting, selection and clicks.
import { icon, esc } from "./model.js";

const SIZE = {
  normal: { w: 290, h: 118, gapY: 20, maxRows: 7 },
  compact: { w: 240, h: 64, gapY: 10, maxRows: 13 },
};
const COL_GAP = 170;
const SUB_GAP = 26;

export function createCanvas(el, handlers) {
  const world = document.createElement("div");
  world.className = "world";
  el.appendChild(world);
  let cam = { x: 40, y: 40, k: 1 };
  let spec = null;
  let layout = null;
  let selected = null;
  let selectedEdge = null;
  let hover = null;
  const cameras = new Map();

  const apply = () => {
    world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})`;
  };

  function render(nextSpec, { selectedId, selectedEdgeId, flash } = {}) {
    const sameKey = spec && nextSpec.key === spec.key;
    if (spec) cameras.set(spec.key, { ...cam });
    spec = nextSpec;
    selected = selectedId ?? null;
    selectedEdge = selectedEdgeId ?? null;
    layout = computeLayout(spec);
    world.innerHTML = "";
    const { width, height } = layout.bounds;
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", `edges ${spec.edgeMode}`);
    svg.setAttribute("width", String(width + 400));
    svg.setAttribute("height", String(height + 400));
    svg.style.left = "-200px";
    svg.style.top = "-200px";
    svg.setAttribute("viewBox", `-200 -200 ${width + 400} ${height + 400}`);
    world.appendChild(svg);

    for (const t of layout.titles) {
      if (!t.title) continue;
      const d = document.createElement("div");
      d.className = "lane-title";
      d.style.left = `${t.x}px`;
      d.style.top = `${t.y}px`;
      d.style.width = `${t.w}px`;
      d.textContent = t.title;
      world.appendChild(d);
    }

    // Edges.
    const ports = new Map();
    const edgeEls = new Map();
    for (const r of layout.routes) {
      const g = document.createElementNS(svgNS, "g");
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("d", r.d);
      path.setAttribute("class", `edge ${r.edge.status}`);
      const hit = document.createElementNS(svgNS, "path");
      hit.setAttribute("d", r.d);
      hit.setAttribute("class", "edge-hit");
      hit.style.pointerEvents = r.edge.status === "tree" ? "none" : "stroke";
      hit.addEventListener("click", (ev) => {
        ev.stopPropagation();
        handlers.onEdge?.(r.edge);
      });
      hit.addEventListener("mouseenter", () => highlight({ edge: r.edge.id }));
      hit.addEventListener("mouseleave", () => highlight(null));
      g.append(path, hit);
      if (r.edge.count > 1 && (layout.routes.length <= 70 || spec.edgeMode === "all") && r.edge.status !== "tree") {
        const label = String(r.edge.count);
        const w = 8 + label.length * 6.5;
        const bg = document.createElementNS(svgNS, "rect");
        bg.setAttribute("x", String(r.mid.x - w / 2));
        bg.setAttribute("y", String(r.mid.y - 8));
        bg.setAttribute("width", String(w));
        bg.setAttribute("height", "16");
        bg.setAttribute("rx", "8");
        bg.setAttribute("class", "edge-count-bg");
        const tx = document.createElementNS(svgNS, "text");
        tx.setAttribute("x", String(r.mid.x));
        tx.setAttribute("y", String(r.mid.y + 3.5));
        tx.setAttribute("text-anchor", "middle");
        tx.setAttribute("class", "edge-count");
        tx.textContent = label;
        g.append(bg, tx);
        g.dataset.count = "1";
      }
      svg.appendChild(g);
      edgeEls.set(r.edge.id, { path, g, edge: r.edge });
      for (const p of [r.p1, r.p2]) {
        if (r.edge.status === "tree") continue;
        const key = `${Math.round(p.x)},${Math.round(p.y)}`;
        if (!ports.has(key)) ports.set(key, { ...p, edges: [] });
        ports.get(key).edges.push(r.edge.id);
      }
    }
    for (const p of ports.values()) {
      const c = document.createElementNS(svgNS, "circle");
      c.setAttribute("cx", String(p.x));
      c.setAttribute("cy", String(p.y));
      c.setAttribute("r", "3.2");
      c.setAttribute("class", "port");
      c.dataset.edges = p.edges.join("\n");
      svg.appendChild(c);
    }

    // Nodes.
    const nodeEls = new Map();
    for (const p of layout.placed) {
      const n = p.node;
      const d = document.createElement("div");
      d.className = `node kind-${n.kind ?? "other"}${n.compact || spec.density === "compact" ? " compact" : ""}${n.changed ? " changed" : ""}${n.dir ? " dir" : ""}${selected === n.id ? " sel" : ""}${flash?.has(n.id) ? " flash" : ""}`;
      d.style.left = `${p.x}px`;
      d.style.top = `${p.y}px`;
      d.style.width = `${p.w}px`;
      d.style.height = `${p.h}px`;
      d.dataset.id = n.id;
      d.tabIndex = -1;
      const chips = (n.chips ?? []).map((c) => `<span class="chip ${c.tone ?? ""}${c.dot ? " dot" : ""}${c.push ? " push" : ""}">${esc(c.text)}</span>`).join("");
      d.innerHTML = `<div class="nh"><span class="ico">${icon(n.icon)}</span><span class="ttl" title="${esc(n.label)}">${esc(n.label)}</span></div>${n.desc ? `<div class="desc">${esc(n.desc)}</div>` : ""}${chips ? `<div class="chips">${chips}</div>` : ""}${n.dir?.hasKids ? `<span class="exp">${n.dir.open ? "−" : "+"}</span>` : ""}`;
      if (n.compact || spec.density === "compact") {
        const ch = d.querySelector(".chips");
        if (ch) {
          ch.style.position = "static";
          ch.style.marginTop = "5px";
          const desc = d.querySelector(".desc");
          if (desc) desc.remove();
        }
      }
      d.addEventListener("mouseenter", () => highlight({ node: n.id }));
      d.addEventListener("mouseleave", () => highlight(null));
      d.addEventListener("click", (ev) => {
        if (moved) return;
        ev.stopPropagation();
        handlers.onSelect?.(n);
      });
      d.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        handlers.onOpen?.(n);
      });
      world.appendChild(d);
      nodeEls.set(n.id, d);
    }
    layout.nodeEls = nodeEls;
    layout.edgeEls = edgeEls;

    // Same view: keep the camera. A view seen before (going back): restore it. A new one: fit to the screen.
    if (sameKey) apply();
    else if (cameras.has(spec.key)) {
      cam = { ...cameras.get(spec.key) };
      apply();
    } else fit();
    highlight(null);
  }

  function adjacency(id) {
    const nodes = new Set([id]);
    const edges = new Set();
    for (const r of layout.routes) {
      if (r.edge.from === id || r.edge.to === id) {
        edges.add(r.edge.id);
        nodes.add(r.edge.from);
        nodes.add(r.edge.to);
      }
    }
    return { nodes, edges };
  }

  function highlight(h) {
    hover = h;
    if (!layout) return;
    const target = h ?? (selectedEdge ? { edge: selectedEdge } : selected ? { node: selected } : null);
    let set = null;
    if (target?.node && layout.nodeEls.has(target.node)) set = adjacency(target.node);
    if (target?.edge) {
      const r = layout.routes.find((x) => x.edge.id === target.edge);
      if (r) set = { nodes: new Set([r.edge.from, r.edge.to]), edges: new Set([r.edge.id]) };
    }
    world.classList.toggle("dim", !!set);
    for (const [id, el] of layout.nodeEls) el.classList.toggle("hl", !!set && set.nodes.has(id));
    for (const [id, { path }] of layout.edgeEls) {
      path.classList.toggle("hl", !!set && set.edges.has(id));
      path.classList.toggle("sel", selectedEdge === id);
    }
    for (const c of world.querySelectorAll("circle.port")) c.classList.toggle("hl", !!set && c.dataset.edges.split("\n").some((e) => set.edges.has(e)));
  }

  function fit() {
    if (!layout) return;
    const r = el.getBoundingClientRect();
    const { minX, minY, width, height } = layout.bounds;
    const top = 150;
    const bottom = 110;
    const availW = Math.max(200, r.width - 80);
    const availH = Math.max(200, r.height - top - bottom);
    const k = Math.max(0.12, Math.min(1.1, availW / (width + 40), availH / (height + 40)));
    cam = { k, x: (r.width - width * k) / 2 - minX * k, y: top + Math.max(0, (availH - height * k) / 2) - minY * k };
    apply();
  }

  function zoomAt(factor, cx, cy) {
    const r = el.getBoundingClientRect();
    const px = cx ?? r.width / 2;
    const py = cy ?? r.height / 2;
    const k = Math.max(0.1, Math.min(2.6, cam.k * factor));
    cam.x = px - ((px - cam.x) * k) / cam.k;
    cam.y = py - ((py - cam.y) * k) / cam.k;
    cam.k = k;
    apply();
  }

  function centerOn(id) {
    const p = layout?.placed.find((x) => x.node.id === id);
    if (!p) return;
    const r = el.getBoundingClientRect();
    cam.x = r.width / 2 - (p.x + p.w / 2) * cam.k;
    cam.y = r.height / 2 - (p.y + p.h / 2) * cam.k;
    apply();
  }

  // Pan and zoom.
  let drag = null;
  let moved = false;
  el.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    drag = { x: ev.clientX, y: ev.clientY, cx: cam.x, cy: cam.y };
    moved = false;
  });
  window.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    moved = true;
    el.classList.add("panning");
    cam.x = drag.cx + dx;
    cam.y = drag.cy + dy;
    apply();
  });
  window.addEventListener("pointerup", () => {
    drag = null;
    el.classList.remove("panning");
    setTimeout(() => (moved = false), 0);
  });
  el.addEventListener("click", () => {
    if (!moved) handlers.onBackground?.();
  });
  el.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const r = el.getBoundingClientRect();
    if (ev.ctrlKey || ev.metaKey || Math.abs(ev.deltaY) >= Math.abs(ev.deltaX)) zoomAt(Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0016)), ev.clientX - r.left, ev.clientY - r.top);
    else {
      cam.x -= ev.deltaX;
      apply();
    }
  }, { passive: false });

  return {
    render,
    fit,
    zoomIn: () => zoomAt(1.2),
    zoomOut: () => zoomAt(1 / 1.2),
    pan: (dx, dy) => {
      cam.x += dx;
      cam.y += dy;
      apply();
    },
    centerOn,
    highlight,
    setSelection(id, edgeId) {
      selected = id;
      selectedEdge = edgeId ?? null;
      if (layout) for (const [nid, elx] of layout.nodeEls) elx.classList.toggle("sel", nid === id);
      highlight(hover);
    },
    has: (id) => !!layout?.nodeEls.has(id),
  };
}

/** Column layout with barycentre ordering, wrapping tall columns into sub-columns. */
function computeLayout(spec) {
  const placed = [];
  const titles = [];
  const size = SIZE[spec.density] ?? SIZE.normal;

  if (spec.positioned) {
    for (const n of spec.positioned) placed.push({ node: n, x: n.x, y: n.y, w: n.w ?? size.w, h: n.h ?? size.h, col: Math.round(n.x / 300) });
  } else {
    const cols = spec.columns.map((c) => ({ ...c, nodes: [...c.nodes] }));
    // Barycentre ordering to reduce crossings (two sweeps), unless the view's order matters.
    if (!spec.keepOrder) {
      const neighbours = new Map();
      for (const e of spec.edges) {
        if (!neighbours.has(e.from)) neighbours.set(e.from, []);
        if (!neighbours.has(e.to)) neighbours.set(e.to, []);
        neighbours.get(e.from).push(e.to);
        neighbours.get(e.to).push(e.from);
      }
      const indexOf = new Map();
      const reindex = () => cols.forEach((c) => c.nodes.forEach((n, i) => indexOf.set(n.id, i / Math.max(1, c.nodes.length - 1))));
      reindex();
      for (const order of [[...cols.keys()], [...cols.keys()].reverse(), [...cols.keys()]]) {
        for (const ci of order) {
          const c = cols[ci];
          if (c.nodes.length < 2) continue;
          const score = (n) => {
            const ns = (neighbours.get(n.id) ?? []).filter((x) => indexOf.has(x) && !c.nodes.some((m) => m.id === x));
            return ns.length ? ns.reduce((s, x) => s + indexOf.get(x), 0) / ns.length : indexOf.get(n.id);
          };
          const scored = c.nodes.map((n) => ({ n, s: score(n) }));
          scored.sort((a, b) => a.s - b.s);
          c.nodes = scored.map((x) => x.n);
          reindex();
        }
      }
    }
    let x = 0;
    const heights = [];
    const colGeom = cols.map((c) => {
      const n = c.nodes.length;
      const subs = Math.max(1, Math.ceil(n / size.maxRows));
      const rows = Math.ceil(n / subs);
      const h = c.nodes.map((nd) => nodeHeight(nd, size));
      const maxH = Math.max(size.h, ...h);
      const colH = rows * (maxH + size.gapY) - size.gapY;
      heights.push(colH);
      const g = { x, subs, rows, rowH: maxH, w: subs * size.w + (subs - 1) * SUB_GAP };
      x += g.w + COL_GAP;
      return g;
    });
    const tallest = Math.max(0, ...heights);
    cols.forEach((c, ci) => {
      const g = colGeom[ci];
      const top = spec.rowAligned ? 0 : (tallest - heights[ci]) / 2;
      titles.push({ title: c.title, x: g.x, y: top - 40, w: g.w });
      c.nodes.forEach((n, i) => {
        const sub = Math.floor(i / g.rows);
        const row = i % g.rows;
        placed.push({ node: n, x: g.x + sub * (size.w + SUB_GAP), y: top + row * (g.rowH + size.gapY), w: size.w, h: nodeHeight(n, size), col: ci, sub });
      });
    });
  }

  const pos = new Map(placed.map((p) => [p.node.id, p]));
  // Distribute ports along each side, ordered by where the other end is.
  const sides = new Map();
  const attach = (id, side, other, edgeId) => {
    const key = `${id}\u0000${side}`;
    if (!sides.has(key)) sides.set(key, []);
    sides.get(key).push({ other, edgeId });
  };
  const plan = [];
  for (const e of spec.edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    let sa;
    let sb;
    if (spec.positioned) {
      sa = "right";
      sb = "left";
    } else if (a.x + a.w <= b.x) {
      sa = "right";
      sb = "left";
    } else if (b.x + b.w <= a.x) {
      sa = "left";
      sb = "right";
    } else {
      sa = "right";
      sb = "right";
    }
    plan.push({ e, a, b, sa, sb });
    attach(e.from, sa, b, e.id);
    attach(e.to, sb, a, e.id);
  }
  const portAt = new Map();
  for (const [key, list] of sides) {
    const [id, side] = key.split("\u0000");
    const p = pos.get(id);
    list.sort((u, v) => u.other.y + u.other.h / 2 - (v.other.y + v.other.h / 2));
    const usable = p.h * 0.72;
    list.forEach((item, i) => {
      const y = list.length === 1 ? p.y + p.h / 2 : p.y + (p.h - usable) / 2 + (usable * i) / (list.length - 1);
      portAt.set(`${item.edgeId}\u0000${id}\u0000${side}`, { x: side === "right" ? p.x + p.w : p.x, y });
    });
  }
  const routes = [];
  for (const { e, a, b, sa, sb } of plan) {
    const p1 = portAt.get(`${e.id}\u0000${e.from}\u0000${sa}`);
    const p2 = portAt.get(`${e.id}\u0000${e.to}\u0000${sb}`);
    if (!p1 || !p2) continue;
    let d;
    let mid;
    if (e.status === "tree") {
      const mx = p1.x + 22;
      d = `M${p1.x},${p1.y} H${mx} V${p2.y} H${p2.x}`;
      mid = { x: mx, y: (p1.y + p2.y) / 2 };
    } else if (sa === sb) {
      const bulge = Math.max(a.x + a.w, b.x + b.w) + 60;
      d = `M${p1.x},${p1.y} C${bulge},${p1.y} ${bulge},${p2.y} ${p2.x},${p2.y}`;
      mid = { x: bulge - 15, y: (p1.y + p2.y) / 2 };
    } else {
      const dir = sa === "right" ? 1 : -1;
      const dx = Math.max(50, Math.abs(p2.x - p1.x) * 0.45);
      d = `M${p1.x},${p1.y} C${p1.x + dir * dx},${p1.y} ${p2.x - dir * dx},${p2.y} ${p2.x},${p2.y}`;
      mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    }
    routes.push({ edge: e, d, p1, p2, mid });
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of placed) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + p.w);
    maxY = Math.max(maxY, p.y + p.h);
  }
  for (const t of titles) minY = Math.min(minY, t.y);
  if (!placed.length) {
    minX = minY = 0;
    maxX = maxY = 100;
  }
  return { placed, titles, routes, bounds: { minX, minY, width: maxX - minX, height: maxY - minY } };
}

function nodeHeight(n, size) {
  if (n.h) return n.h;
  return size.h;
}

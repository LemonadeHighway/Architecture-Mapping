// Turns the per-file facts into one graph. Every node has a parent (system > layer > module > file > item), and every
// edge has a status:
//   verified   - a literal syntactic fact with both ends located (an import that resolves to a file, a route guard,
//                a handler parameter type, a table name in a SQL string, a foreign key);
//   inferred   - a name match or a convention (a C# identifier equal to a type name, a test that names a class,
//                a workflow step matched by keyword, a call path with unknown segments);
//   unresolved - we found one end but not the other (an API call that matches no route).
// Each edge carries evidence: file, line and the reason.
import { posix } from "node:path";
import { replaySchema } from "./sql.mjs";
import { authFromAttributes } from "./csharp.mjs";
import { knownServices } from "./services.mjs";

const LAYERS = [
  ["web", "Web app", "The screens people use (the frontend app)"],
  ["api", "API", "The server's HTTP addresses: minimal APIs and controllers"],
  ["infrastructure", "Infrastructure", "Data access and outside services"],
  ["domain", "Domain", "Business rules and shared types"],
  ["database", "Database", "The schema, rebuilt by replaying the migrations in order"],
  ["external", "External services", "Services and packages outside this repository"],
  ["security", "Permissions & roles", "Who may do what: permissions, policies, roles"],
  ["tests", "Tests", "Automated tests"],
  ["docs", "Docs", "Documentation"],
  ["config", "Config", "Projects, packages and settings files"],
  ["workflow", "Business workflow", "The business process, from the configured document"],
  ["other", "Other files", "Files no scanner reads (PDFs, images, ...)"],
];

export function buildGraph({ files, results, git, config, layout, scanErrors }) {
  const workflowMap = config.workflow ?? null;
  const nodes = new Map();
  const edges = new Map();
  const notes = []; // things the builder couldn't settle, for coverage

  const addNode = (n) => {
    if (!nodes.has(n.id)) nodes.set(n.id, { tags: [], data: {}, ...n });
    return nodes.get(n.id);
  };
  const addEdge = (from, to, kind, status, evidence, extra = {}) => {
    if (!from || !to || from === to) return null;
    const id = `${kind}|${from}|${to}`;
    let e = edges.get(id);
    if (!e) {
      e = { id, from, to, kind, status, evidence: [], count: 0, ...extra };
      edges.set(id, e);
    } else {
      if (rank(status) > rank(e.status)) e.status = status;
      if (extra.items) e.items = [...new Set([...(e.items ?? []), ...extra.items])].slice(0, 40);
    }
    e.count++;
    if (evidence && e.evidence.length < 25) e.evidence.push(evidence);
    return e;
  };

  // System and layers.
  addNode({ id: "system", type: "system", label: config.name ?? "System", parent: null, desc: "" });
  for (const [key, label, desc] of LAYERS) addNode({ id: `layer:${key}`, type: "layer", label, parent: "system", layer: key, desc });

  const byPath = new Map(files.map((f) => [f.path, f]));
  const res = (p) => results.get(p);

  // Modules and files.
  for (const f of files) {
    const c = f.cls;
    addNode({ id: `module:${c.module}`, type: "module", label: c.moduleLabel, parent: `layer:${c.layer}`, layer: c.layer, desc: "", data: { feature: c.feature ?? null } });
    const r = res(f.path);
    addNode({
      id: `file:${f.path}`,
      type: "file",
      label: f.path.split("/").pop(),
      parent: `module:${c.module}`,
      layer: c.layer,
      file: f.path,
      line: 1,
      desc: r?.summary ?? r?.title ?? (c.scanner ? "" : `Not analyzed: ${c.reason}`),
      data: { scanner: c.scanner, lines: r?.lines ?? null, size: f.size, error: r?.error ?? null, notAnalyzed: c.scanner ? null : c.reason },
    });
  }

  // ---------- C# ----------
  const cs = files.filter((f) => res(f.path)?.kind === "csharp");
  const typeIndex = new Map(); // name -> [{path, type, ns, layer}]
  for (const f of cs) {
    const r = res(f.path);
    for (const t of r.types) {
      const id = `type:${f.path}#${t.name}`;
      addNode({
        id,
        type: "type",
        label: t.name,
        parent: `file:${f.path}`,
        layer: f.cls.layer,
        file: f.path,
        line: t.line,
        desc: t.summary ?? "",
        data: { kind: t.kind, bases: t.bases, namespace: r.namespace, visibility: t.visibility, partial: t.partial },
      });
      const list = typeIndex.get(t.name) ?? [];
      list.push({ path: f.path, type: t, ns: r.namespace, layer: f.cls.layer, id });
      typeIndex.set(t.name, list);
    }
  }
  const visibleNamespaces = (r) => {
    const set = new Set();
    if (r.namespace) {
      const parts = r.namespace.split(".");
      for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join("."));
    }
    for (const u of r.usings) set.add(u.ns);
    return set;
  };
  /** Resolves a type name as seen from file r: [{entry, status}] */
  const resolveType = (name, r, fromPath, qualifiers = []) => {
    const all = (typeIndex.get(name) ?? []).filter((e) => e.path !== fromPath);
    if (!all.length) return [];
    const vis = visibleNamespaces(r);
    const visible = all.filter((e) => vis.has(e.ns) || qualifiers.some((q) => q === e.ns || q.endsWith(`.${e.ns}`) || e.ns.endsWith(q)));
    if (visible.length === 1) return [{ entry: visible[0], status: "inferred", confidence: "high" }];
    if (visible.length > 1) {
      const partial = visible.every((v) => v.type.partial && v.ns === visible[0].ns);
      return visible.map((entry) => ({ entry, status: "inferred", confidence: partial ? "high" : "low" }));
    }
    return [];
  };

  // Type references between C# files (inferred: name match, namespace visible).
  let typeRefCandidates = 0;
  for (const f of cs) {
    const r = res(f.path);
    const own = new Set(r.types.map((t) => t.name));
    const perTarget = new Map();
    for (const [name, tok] of Object.entries(r.typeTokens)) {
      if (own.has(name)) continue;
      for (const { entry, confidence } of resolveType(name, r, f.path, tok.qualifiers)) {
        typeRefCandidates++;
        const key = entry.path;
        const cur = perTarget.get(key) ?? { names: [], line: tok.line, confidence };
        cur.names.push(name);
        cur.line = Math.min(cur.line, tok.line);
        if (confidence === "low") cur.confidence = "low";
        perTarget.set(key, cur);
      }
    }
    for (const [target, info] of perTarget) {
      addEdge(`file:${f.path}`, `file:${target}`, "uses-type", "inferred", { file: f.path, line: info.line, note: `names ${info.names.slice(0, 6).join(", ")}${info.names.length > 6 ? "…" : ""} (identifier match, namespace in scope; ${info.confidence} confidence)` }, { items: info.names, confidence: info.confidence });
    }
  }

  // Inheritance / interface implementation (verified syntax, target resolved by name).
  for (const f of cs) {
    const r = res(f.path);
    for (const t of r.types) {
      for (const b of t.bases) {
        const targets = resolveType(b, r, f.path);
        for (const { entry, confidence } of targets) {
          addEdge(`type:${f.path}#${t.name}`, entry.id, "implements", targets.length === 1 ? "verified" : "inferred", { file: f.path, line: t.line, note: `${t.name} : ${b}${targets.length > 1 ? ` (${targets.length} types named ${b})` : ""}` }, { confidence });
        }
      }
    }
  }

  // Method index of the application code (API, infrastructure, domain), for following permission checks from a
  // handler into the helpers, stores and business rules it calls.
  const apiMethods = new Map();
  for (const f of cs.filter((x) => ["api", "infrastructure", "domain"].includes(x.cls.layer))) {
    const r = res(f.path);
    for (const m of r.methods) {
      const list = apiMethods.get(m.name) ?? [];
      list.push({ path: f.path, m, types: r.types.map((t) => t.name), layer: f.cls.layer });
      apiMethods.set(m.name, list);
    }
  }
  const fallback = cs.map((f) => ({ f, fb: res(f.path).fallbackPolicy })).find((x) => x.fb);
  const fallbackEvidence = fallback ? { file: fallback.f.path, line: fallback.fb.line, requiresSignIn: fallback.fb.requiresSignIn } : null;
  const layerOfPath = (p) => byPath.get(p)?.cls.layer;
  const implementors = new Map(); // interface or base type name -> names of types that list it as a base
  for (const f of cs) for (const t of res(f.path).types) for (const b of t.bases) implementors.set(b, [...(implementors.get(b) ?? []), t.name]);

  /**
   * Permission checks reachable from a method body, following calls up to 4 levels:
   *   Name(...)          a method of the same file (verified link)
   *   Type.Name(...)     a static method of a repo type (verified link)
   *   param.Name(...)    an instance method, typed by the handler's parameter (verified link)
   *   local.Name(...)    an instance method whose name exists on exactly one repo type (inferred link)
   */
  const guardFrom = (path, signals, calls, params, depth, seen, via, inferred) => {
    const g = { signIn: [], requires: [], allows: [] };
    const layer = layerOfPath(path);
    if (signals.resolvesUser) g.signIn.push({ file: path, line: null, via, layer, inferred });
    for (const x of signals.requires) g.requires.push({ permission: x.permission, file: path, line: x.line, via, argText: x.argText, layer, inferred });
    for (const x of signals.allows) g.allows.push({ permission: x.permission, role: x.role ?? null, policy: x.policy ?? null, builtIn: x.builtIn ?? null, file: path, line: x.line, via, argText: x.argText, layer, inferred });
    if (depth >= 4) return g;
    for (const call of calls) {
      let cands = [];
      let guess = false;
      const uniqueOwner = (name) => {
        const all = (apiMethods.get(name) ?? []).filter((c) => c.layer !== "api" && c.m.owner);
        return new Set(all.map((c) => `${c.path}#${c.m.owner}`)).size === 1 ? all : [];
      };
      if (call.startsWith("@")) {
        const [recv, name] = call.slice(1).split(".");
        const param = params?.find((p) => p.name === recv);
        if (param?.baseType) {
          const owners = new Set([param.baseType, ...(implementors.get(param.baseType) ?? [])]);
          cands = (apiMethods.get(name) ?? []).filter((c) => owners.has(c.m.owner));
        } else {
          cands = uniqueOwner(name);
          guess = true;
        }
      } else if (call.startsWith(".")) {
        cands = uniqueOwner(call.slice(1));
        guess = true;
      } else if (call.includes(".")) {
        const [owner, name] = call.split(".");
        cands = (apiMethods.get(name) ?? []).filter((c) => c.m.owner === owner);
        if (!cands.length && !typeIndex.has(owner)) {
          // job.Progress.Complete(...): Progress is a property, not a type. Try a type whose name ends with it
          // (JobProgress), then a method name that exists on one type only. Both are guesses.
          cands = (apiMethods.get(name) ?? []).filter((c) => c.layer !== "api" && c.m.owner?.endsWith(owner));
          if (!cands.length) cands = uniqueOwner(name);
          guess = true;
        }
      } else {
        const all = apiMethods.get(call) ?? [];
        const same = all.filter((c) => c.path === path);
        cands = same.length ? same : all.length === 1 ? all : [];
      }
      for (const cand of cands.slice(0, 3)) {
        const key = `${cand.path}#${cand.m.name}#${cand.m.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sub = guardFrom(cand.path, cand.m.signals, cand.m.calls, cand.m.params, depth + 1, seen, `${via} → ${cand.m.name}`, inferred || guess);
        for (const k of Object.keys(g)) g[k].push(...sub[k].map((x) => ({ ...x, line: x.line ?? cand.m.line })));
      }
    }
    return g;
  };

  // Route prefixes: follow `var g = parent.MapGroup("/x")` and `api.MapX()` calls back to the root.
  const extCallIndex = new Map();
  for (const f of cs) for (const c of res(f.path).extCalls) {
    const list = extCallIndex.get(c.name) ?? [];
    list.push({ path: f.path, ...c });
    extCallIndex.set(c.name, list);
  }
  const prefixMemo = new Map();
  const prefixesOf = (path, methodName, varName, depth = 0) => {
    const key = `${path}|${methodName}|${varName}`;
    if (prefixMemo.has(key)) return prefixMemo.get(key);
    prefixMemo.set(key, [{ prefix: null, hops: [], reason: "cycle" }]);
    const r = res(path);
    let out = [];
    const group = r.groups.find((g) => g.var === varName && g.method === methodName);
    const method = r.methods.find((m) => m.name === methodName && m.thisParam?.name === varName);
    const root = r.rootVars.find((v) => v.var === varName && v.method === methodName);
    if (depth > 8) out = [{ prefix: null, hops: [], reason: "too deep" }];
    else if (group) {
      for (const p of prefixesOf(path, methodName, group.parent, depth + 1)) {
        out.push({
          prefix: p.prefix === null || group.prefix === null ? null : joinRoute(p.prefix, group.prefix),
          hops: [...p.hops, { file: path, line: group.line, text: `${group.var} = ${group.parent}.MapGroup("${group.prefix ?? "?"}")` }],
          groupChain: [...(p.groupChain ?? []), ...group.chain],
          reason: group.prefix === null ? "group prefix is not a literal" : p.reason,
        });
      }
    } else if (root) out = [{ prefix: "", hops: [{ file: path, line: root.line, text: `${root.var} = builder.Build()` }], groupChain: [] }];
    else if (method) {
      const callers = extCallIndex.get(methodName) ?? [];
      if (!callers.length) out = [{ prefix: null, hops: [{ file: path, line: method.line, text: `${methodName}(this ${method.thisParam.type} ${varName})` }], reason: `${methodName} is never called` }];
      for (const c of callers) {
        for (const p of prefixesOf(c.path, c.method, c.receiver, depth + 1)) {
          out.push({ prefix: p.prefix, hops: [...p.hops, { file: c.path, line: c.line, text: `${c.receiver}.${methodName}()` }], groupChain: p.groupChain ?? [], reason: p.reason });
        }
      }
    } else out = [{ prefix: null, hops: [], reason: `can't tell where "${varName}" comes from` }];
    prefixMemo.set(key, out);
    return out;
  };

  // Endpoints.
  const endpoints = [];
  const endpointNotes = [];
  // Only the API project maps the application's routes; test projects map throwaway routes of their own.
  for (const f of cs.filter((x) => x.cls.layer !== "tests")) {
    const r = res(f.path);
    for (const mc of r.mapCalls) {
      const prefixes = prefixesOf(f.path, mc.method, mc.receiver);
      for (const p of prefixes) {
        for (const verb of mc.verbs.length ? mc.verbs : ["?"]) {
          const resolved = p.prefix !== null && mc.pattern !== null && !mc.pattern.includes("{?}");
          const route = resolved ? joinRoute(p.prefix, mc.pattern) : `${p.prefix ?? "{?}"}${mc.pattern ?? "{?}"}`;
          const id = `endpoint:${verb} ${route}`;
          const dup = nodes.has(id);
          const ep = addNode({
            id: dup ? `${id}#${f.path}:${mc.line}` : id,
            type: "endpoint",
            label: `${verb} ${route}`,
            parent: `file:${f.path}`,
            layer: "api",
            file: f.path,
            line: mc.line,
            desc: "",
            data: { verb, route, resolved, prefixHops: p.hops, prefixReason: resolved ? null : p.reason ?? "pattern is not a literal", duplicateOf: dup ? id : null, helper: mc.helper ?? null },
          });
          endpoints.push({ node: ep, f, r, mc, groupChain: p.groupChain ?? [] });
          if (!resolved) endpointNotes.push({ file: f.path, line: mc.line, what: `route not fully resolved: ${p.reason ?? "pattern is not a literal"}` });
        }
      }
    }
  }

  // Controllers ([Route] + [HttpGet] ...). MapControllers().RequireAuthorization() applies to all of them.
  const controllersChain = cs.flatMap((f) => (res(f.path).mapControllers ?? []).map((mc) => ({ ...mc, file: f.path })));
  for (const f of cs.filter((x) => x.cls.layer !== "tests")) {
    const r = res(f.path);
    for (const ce of r.controllerEndpoints ?? []) {
      const id = `endpoint:${ce.verb} ${ce.route}`;
      const dup = nodes.has(id);
      const ep = addNode({
        id: dup ? `${id}#${f.path}:${ce.line}` : id,
        type: "endpoint",
        label: `${ce.verb} ${ce.route}`,
        parent: `file:${f.path}`,
        layer: f.cls.layer,
        file: f.path,
        line: ce.line,
        desc: "",
        data: { verb: ce.verb, route: ce.route, resolved: !ce.route.includes("{?}"), controller: ce.className, prefixHops: [{ file: f.path, line: ce.classLine, text: `${ce.className} [Route] + [Http${ce.verb[0]}${ce.verb.slice(1).toLowerCase()}] on ${ce.method}` }], duplicateOf: dup ? id : null },
      });
      endpoints.push({ node: ep, f, r, controller: ce });
    }
  }

  const guardSet = new Set(config.backend?.routeGuards ?? []);
  const PERM = config.backend?.permissionEnum ?? null;
  const policyId = (name) => `perm:policy:${name}`;
  const roleId = (name) => `role:${name}`;

  // Handlers, guards and injected services: one pass for minimal-API routes and controller actions.
  for (const item of endpoints) {
    const { node: ep, f, r } = item;
    const routeAuth = []; // { kind: permission | policy | role | signed-in, name, file, line, note }
    let anonymous = null;
    const other = [];
    let handler = null;
    let params = [];
    let extraInjected = [];
    let guard = { signIn: [], requires: [], allows: [] };
    let bodyTypes = [];

    const readChainAuth = (chain, file) => {
      for (const c of chain) {
        if (c.name === "AllowAnonymous") anonymous = { file, line: c.line };
        else if (c.name === "RequireAuthorization") {
          if (c.strings?.length) for (const p of c.strings) routeAuth.push({ kind: "policy", name: p, file, line: c.line, note: `.RequireAuthorization("${p}")` });
          else routeAuth.push({ kind: "signed-in", name: null, file, line: c.line, note: `.RequireAuthorization(${c.args})` });
        } else if (guardSet.has(c.name)) {
          const lit = PERM ? new RegExp(`\\b${PERM}\\.(\\w+)`).exec(c.args) : null;
          const alias = /^(\w+)/.exec(c.args)?.[1];
          const perm = lit ? lit[1] : r.constPerms[alias] ?? c.strings?.[0] ?? null;
          routeAuth.push({ kind: "permission", name: perm, file, line: c.line, argText: c.args, note: `.${c.name}(${c.args})${!lit && perm && r.constPerms[alias] ? ` — ${alias} = ${PERM}.${perm}` : ""}`, ownRecordPasses: /Own/.test(c.name) });
        } else other.push({ name: c.name, args: c.args, line: c.line });
      }
    };

    if (item.controller) {
      const ce = item.controller;
      const a = ce.auth;
      if (a.anonymous) anonymous = { file: f.path, line: a.anonymous.line };
      for (const p of a.policies) routeAuth.push({ kind: "policy", name: p.name, file: f.path, line: p.line, note: `[Authorize(Policy = "${p.name}")]` });
      for (const ro of a.roles) routeAuth.push({ kind: "role", name: ro.name, file: f.path, line: ro.line, note: `[Authorize(Roles = "…${ro.name}…")]` });
      if (a.authorize && !a.policies.length && !a.roles.length) routeAuth.push({ kind: "signed-in", name: null, file: f.path, line: ce.line, note: "[Authorize]" });
      for (const mc of controllersChain) readChainAuth(mc.chain, mc.file);
      const m = r.methods.find((x) => x.name === ce.method && x.owner === ce.className);
      if (m) {
        handler = { kind: "method", name: m.name, file: f.path, line: m.line, summary: m.summary };
        params = m.params;
        guard = guardFrom(f.path, m.signals, m.calls, [...m.params, ...ce.injected], 0, new Set([`${f.path}#${m.name}#${m.line}`]), m.name, false);
        bodyTypes = m.bodyTypes;
      }
      extraInjected = ce.injected.map((p) => ({ ...p, viaConstructor: true }));
    } else {
      const mc = item.mc;
      readChainAuth([...(item.groupChain ?? [])], f.path);
      readChainAuth(mc.chain, f.path);
      if (mc.handler?.kind === "method") {
        let cands = r.methods.filter((m) => m.name === mc.handler.name && !m.thisParam);
        let hPath = f.path;
        if (!cands.length || (mc.handler.owner && !r.types.some((t) => t.name === mc.handler.owner))) {
          const elsewhere = (apiMethods.get(mc.handler.name) ?? []).filter((c) => c.layer !== "tests" && (!mc.handler.owner || c.types.includes(mc.handler.owner)));
          if (elsewhere.length) {
            cands = [elsewhere[0].m];
            hPath = elsewhere[0].path;
          }
        }
        if (cands.length) {
          const m = cands[0];
          handler = { kind: "method", name: m.name, file: hPath, line: m.line, overloads: cands.length, summary: m.summary };
          params = m.params;
          const ha = authFromAttributes(m.attributes ?? []);
          if (ha.anonymous) anonymous = { file: hPath, line: ha.anonymous.line };
          for (const p of ha.policies) routeAuth.push({ kind: "policy", name: p.name, file: hPath, line: p.line, note: `[Authorize("${p.name}")] on the handler` });
          if (ha.authorize && !ha.policies.length) routeAuth.push({ kind: "signed-in", name: null, file: hPath, line: m.line, note: "[Authorize] on the handler" });
          guard = guardFrom(hPath, m.signals, m.calls, m.params, 0, new Set([`${hPath}#${m.name}#${m.line}`]), m.name, false);
          bodyTypes = m.bodyTypes;
        } else {
          handler = { kind: "method", name: mc.handler.name, file: null, line: null, unresolved: true };
          endpointNotes.push({ file: f.path, line: mc.line, what: `handler ${mc.handler.name} not found` });
        }
      } else if (mc.handler?.kind === "lambda") {
        handler = { kind: "lambda", file: f.path, line: mc.handler.line, text: mc.handler.text };
        params = mc.handler.params;
        const la = authFromAttributes(mc.handler.attributes ?? []);
        if (la.anonymous) anonymous = { file: f.path, line: la.anonymous.line };
        for (const p of la.policies) routeAuth.push({ kind: "policy", name: p.name, file: f.path, line: p.line, note: `[Authorize("${p.name}")] on the lambda` });
        if (la.authorize && !la.policies.length) routeAuth.push({ kind: "signed-in", name: null, file: f.path, line: mc.handler.line, note: "[Authorize] on the lambda" });
        guard = guardFrom(f.path, mc.handler.signals, mc.handler.calls, mc.handler.params, 0, new Set(), "inline handler", false);
        bodyTypes = mc.handler.bodyTypes;
      } else if (mc.handler) {
        handler = { kind: "expression", file: f.path, line: mc.handler.line, text: mc.handler.text, unresolved: true };
        endpointNotes.push({ file: f.path, line: mc.line, what: "handler is an expression the scanner can't follow" });
      }
    }

    // Who may call it, strongest evidence first.
    const routeNamed = routeAuth.filter((x) => x.kind !== "signed-in");
    const handlerReq = guard.requires.filter((x) => x.permission);
    const handlerReqComputed = guard.requires.filter((x) => !x.permission);
    const allowsNamed = guard.allows.filter((x) => x.permission || x.role || x.policy);
    let level;
    if (anonymous) level = "anonymous";
    else if (routeNamed.length) level = routeNamed.every((p) => p.name) ? "permission-route" : "permission-route-computed";
    else if (handlerReq.length) level = handlerReq.some((x) => x.layer === "api") ? "permission-handler" : "permission-domain";
    else if (handlerReqComputed.length) level = "permission-handler-computed";
    else if (allowsNamed.length) level = "permission-allows";
    else if (routeAuth.length || fallbackEvidence?.requiresSignIn || guard.signIn.length) level = "signed-in";
    else level = "no-auth-found";
    ep.data.auth = { level, anonymous, routeAuth, handlerRequires: guard.requires, handlerAllows: guard.allows, signInInHandler: guard.signIn.length > 0, fallback: fallbackEvidence };
    ep.data.handler = handler;
    ep.data.chain = other;
    ep.data.params = [...params, ...extraInjected].map((p) => ({ type: p.type, name: p.name, viaConstructor: !!p.viaConstructor }));
    ep.desc = handler?.summary ?? describeAuth(ep.data.auth);
    ep.tags.push(level);

    const permTarget = (x) => (x.kind === "policy" || x.policy ? policyId(x.name ?? x.policy) : x.kind === "role" || x.role ? roleId(x.name ?? x.role) : `perm:${x.name ?? x.permission}`);
    for (const p of routeNamed) if (p.name) addEdge(ep.id, permTarget(p), "guarded-by", "verified", { file: p.file, line: p.line, note: p.note });
    for (const x of handlerReq) addEdge(ep.id, `perm:${x.permission}`, "checked-in-handler", x.inferred ? "inferred" : "verified", { file: x.file, line: x.line, note: `${x.argText ? `check(${x.argText})` : "check"} — ${x.via}${x.inferred ? " (one call in the chain matched by method name only)" : ""}` });
    for (const x of allowsNamed) addEdge(ep.id, x.policy ? policyId(x.policy) : x.role ? roleId(x.role) : `perm:${x.permission}`, "conditional-on", x.inferred ? "inferred" : "verified", { file: x.file, line: x.line, note: `${x.builtIn ?? "check"}(${x.argText}) — ${x.via}: decides a branch (refuse, or show less), not a gate by itself${x.inferred ? "; chain matched by method name" : ""}` });

    // Injected services and domain types.
    for (const p of [...params, ...extraInjected]) {
      if (!p.baseType) continue;
      const cands = (typeIndex.get(p.baseType) ?? []).filter((e) => e.layer === "infrastructure" || e.layer === "domain");
      for (const c of cands) {
        addEdge(ep.id, c.id, c.layer === "infrastructure" || p.viaConstructor ? "injects" : "binds", cands.length === 1 ? "verified" : "inferred", { file: handler?.file ?? f.path, line: handler?.line ?? ep.line, note: `${p.viaConstructor ? "controller constructor" : "handler"} parameter ${p.type} ${p.name}` });
      }
    }
    const paramTypes = new Set(params.map((p) => p.baseType));
    for (const name of bodyTypes) {
      if (paramTypes.has(name)) continue;
      const cands = (typeIndex.get(name) ?? []).filter((e) => e.layer === "domain" || e.layer === "infrastructure");
      if (cands.length === 1) addEdge(ep.id, cands[0].id, "uses", "inferred", { file: handler?.file ?? f.path, line: handler?.line ?? ep.line, note: `${name} named in the handler body` });
    }
  }

  // DI registrations.
  const diTypes = new Set();
  for (const f of cs) {
    for (const d of res(f.path).di) {
      const impl = d.impl ? typeIndex.get(d.impl) ?? [] : [];
      const svc = d.service && d.service !== d.impl ? typeIndex.get(d.service) ?? [] : [];
      for (const t of impl) {
        diTypes.add(t.id);
        addEdge(`file:${f.path}`, t.id, "registers", d.fromFactory ? "inferred" : "verified", { file: f.path, line: d.line, note: `${d.tryAdd ? "TryAdd" : "Add"}${d.lifetime}${d.fromFactory ? " (factory: type read from the lambda)" : `<${d.service}${d.service !== d.impl ? `, ${d.impl}` : ""}>`}` });
        for (const s of svc) addEdge(s.id, t.id, "implemented-by", "verified", { file: f.path, line: d.line, note: `registered as ${d.service} → ${d.impl}` });
      }
      if (d.impl && !impl.length && !/^[A-Z]\w*$/.test(d.impl ?? "")) notes.push({ file: f.path, line: d.line, what: `DI registration of ${d.impl} not resolved` });
    }
  }

  // ---------- Database ----------
  const migrations = files.filter((f) => res(f.path)?.kind === "migration").map((f) => ({ path: f.path, data: res(f.path) }));
  const schema = replaySchema(migrations);
  const efSets = cs.flatMap((f) => (res(f.path).dbSets ?? []).map((d) => ({ ...d, file: f.path })));
  const efNames = new Map();
  for (const f of cs) for (const t of res(f.path).efTables ?? []) efNames.set(t.entity, { ...t, file: f.path });
  addNode({
    id: "module:database/schema",
    type: "module",
    label: "Schema (final)",
    parent: "layer:database",
    layer: "database",
    desc: migrations.length ? `${schema.tables.length} tables after replaying ${migrations.length} migrations in order` : efSets.length ? `${efSets.length} tables from EF Core DbSet properties (no SQL migrations found)` : "No SQL migrations or EF Core DbSets found",
  });
  const tableNames = new Set(schema.tables.map((t) => t.name));
  const lowerTables = new Map(schema.tables.map((t) => [t.name.toLowerCase(), t.name]));
  for (const t of schema.tables) {
    addNode({
      id: `table:${t.name}`,
      type: "table",
      label: t.name,
      parent: "module:database/schema",
      layer: "database",
      file: t.created.file,
      line: t.created.line,
      desc: `${t.columns.length} columns · ${t.fks.length} foreign keys${t.policies.length ? " · row-level security" : ""}`,
      data: { source: "migrations", columns: t.columns, fks: t.fks, indexes: t.indexes, triggers: t.triggers, policies: t.policies, rls: t.rls, rlsForced: t.rlsForced, dynamic: t.dynamic ?? [], history: t.history, created: t.created, primaryKey: t.primaryKey ?? null, checks: t.checks },
    });
    addEdge(`file:${t.created.file}`, `table:${t.name}`, "creates", "verified", { file: t.created.file, line: t.created.line, note: `CREATE TABLE ${t.name}` });
    for (const h of t.history.filter((x) => x.file !== t.created.file)) addEdge(`file:${h.file}`, `table:${t.name}`, "alters", "verified", { file: h.file, line: h.line, note: h.what });
  }
  for (const t of schema.tables) {
    for (const fk of t.fks) {
      addEdge(`table:${t.name}`, `table:${fk.to}`, "fk", fk.targetExists ? "verified" : "unresolved", { file: fk.file, line: fk.line, note: `(${fk.columns.join(", ")}) → ${fk.to} (${fk.toColumns.join(", ")})${fk.onDelete ? ` ON DELETE ${fk.onDelete.toUpperCase()}` : ""}` });
    }
  }
  // EF Core: a DbSet<Order> Orders maps to a table (ToTable("x") when given, else the property name by convention).
  for (const d of efSets) {
    const explicit = efNames.get(d.entity);
    const tableName = explicit?.table ?? d.name;
    const existing = lowerTables.get(tableName.toLowerCase());
    const id = `table:${existing ?? tableName}`;
    if (!nodes.has(id)) {
      addNode({ id, type: "table", label: tableName, parent: "module:database/schema", layer: "database", file: d.file, line: d.line, desc: `EF Core entity ${d.entity}`, data: { source: "ef", entity: d.entity, columns: [], fks: [], indexes: [], triggers: [], policies: [], rls: false, dynamic: [], history: [], created: { file: d.file, line: d.line }, primaryKey: null } });
    }
    const ctxType = d.context ? `type:${d.file}#${d.context}` : `file:${d.file}`;
    addEdge(nodes.has(ctxType) ? ctxType : `file:${d.file}`, id, "maps", explicit ? "verified" : "inferred", { file: explicit?.file ?? d.file, line: explicit?.line ?? d.line, note: explicit ? `Entity<${d.entity}>().ToTable("${tableName}")` : `DbSet<${d.entity}> ${d.name} (table name by EF convention)` });
    for (const e of typeIndex.get(d.entity) ?? []) addEdge(e.id, id, "maps", "inferred", { file: d.file, line: d.line, note: `entity ${d.entity} stored in ${tableName}` });
  }
  // SQL in C#: type -> table.
  const sqlUnknown = [];
  for (const f of cs) {
    for (const s of res(f.path).sql) {
      const from = s.type && nodes.has(`type:${f.path}#${s.type}`) ? `type:${f.path}#${s.type}` : `file:${f.path}`;
      for (const t of s.tables) {
        const name = tableNames.has(t.name) ? t.name : lowerTables.get(t.name.toLowerCase());
        if (name) {
          const kind = t.op === "read" ? "reads" : t.op === "write" ? "writes" : "reads-writes";
          addEdge(from, `table:${name}`, kind, "verified", { file: f.path, line: s.line, note: `${t.op} ${name} in SQL${s.method ? ` (${s.method})` : ""}${s.dynamic ? " — SQL has interpolated parts" : ""}` });
        } else sqlUnknown.push({ file: f.path, line: s.line, name: t.name });
      }
    }
  }
  for (const f of files.filter((x) => res(x.path)?.kind === "sql")) {
    for (const t of res(f.path).tables) if (tableNames.has(t)) addEdge(`file:${f.path}`, `table:${t}`, "touches", "verified", { file: f.path, line: 1, note: "SQL script" });
  }

  // ---------- TypeScript ----------
  const tsFiles = files.filter((f) => res(f.path)?.kind === "typescript");
  const npm = new Map();
  for (const f of files.filter((x) => res(x.path)?.packages && x.path.endsWith("package.json"))) {
    for (const p of res(f.path).packages) if (!npm.has(p.name)) npm.set(p.name, { ...p, file: f.path });
  }
  addNode({ id: "module:external/npm", type: "module", label: "npm packages", parent: "layer:external", layer: "external", desc: "Packages from the package.json files" });
  addNode({ id: "module:external/nuget", type: "module", label: "NuGet packages", parent: "layer:external", layer: "external", desc: "Packages from the .csproj files" });
  for (const [name, p] of npm) {
    addNode({ id: `pkg:npm:${name}`, type: "package", label: name, parent: "module:external/npm", layer: "external", file: p.file, line: p.line, desc: `${p.version}${p.dev ? " (dev)" : ""}` });
    addEdge(`file:${p.file}`, `pkg:npm:${name}`, "declares", "verified", { file: p.file, line: p.line, note: `${name}@${p.version}` });
  }
  const aliases = (layout?.aliases ?? []).slice().sort((a, b) => b.prefix.length - a.prefix.length);
  const resolveImport = (from, spec) => {
    let bases = [];
    const alias = aliases.filter((a) => spec.startsWith(a.prefix));
    if (alias.length) bases = alias.map((a) => posix.normalize(`${a.target}/${spec.slice(a.prefix.length)}`).replace(/^\.\//, ""));
    else if (spec.startsWith(".")) bases = [posix.normalize(posix.join(posix.dirname(from), spec))];
    else return null;
    for (const base of bases) {
      for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.jsx`, base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx")]) if (byPath.has(cand)) return cand;
    }
    return undefined;
  };
  const tsImportsOf = new Map();
  const unresolvedImports = [];
  for (const f of tsFiles) {
    const r = res(f.path);
    const targets = [];
    for (const imp of r.imports) {
      const target = resolveImport(f.path, imp.spec);
      if (target) {
        targets.push(target);
        addEdge(`file:${f.path}`, `file:${target}`, "imports", "verified", { file: f.path, line: imp.line, note: `import ${imp.names.slice(0, 5).join(", ")}${imp.names.length > 5 ? "…" : ""} from "${imp.spec}"${imp.typeOnly ? " (types only)" : ""}` }, { items: imp.names });
      } else if (target === undefined) {
        if (!/\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|json|ico|woff2?)(\?.*)?$/.test(imp.spec)) unresolvedImports.push({ file: f.path, line: imp.line, spec: imp.spec });
      } else {
        const pkgName = imp.spec.startsWith("@") ? imp.spec.split("/").slice(0, 2).join("/") : imp.spec.split("/")[0];
        if (npm.has(pkgName)) addEdge(`file:${f.path}`, `pkg:npm:${pkgName}`, "imports", "verified", { file: f.path, line: imp.line, note: `import from "${imp.spec}"` });
        else if (!/^(node:|virtual:|~|#)|^(fs|path|url|os|util|crypto|module|child_process|http|https|stream|events|assert|zlib|buffer)$/.test(imp.spec)) unresolvedImports.push({ file: f.path, line: imp.line, spec: imp.spec, package: true });
      }
    }
    tsImportsOf.set(f.path, targets);
  }
  // HTTP calls -> endpoints.
  addNode({ id: "unresolved:api", type: "unresolved", label: "Unmatched API calls", parent: "layer:web", layer: "web", desc: "Calls whose path matches no mapped route, or whose path the scanner couldn't work out" });
  const epList = endpoints.map((e) => e.node).filter((n) => n.data.resolved && !n.data.duplicateOf);
  const callStats = { total: 0, verified: 0, inferred: 0, unresolved: 0, dynamic: 0, helperInternal: 0, external: 0, noBackend: 0 };
  const callRecords = [];
  const frontendHosts = new Map();
  for (const f of tsFiles.filter((x) => x.cls.layer !== "tests")) {
    const r = res(f.path);
    for (const c of r.apiCalls) {
      if (r.definesApiHelper && !c.resolved) {
        callStats.helperInternal++;
        continue;
      }
      callStats.total++;
      const ev = { file: f.path, line: c.line, note: `${c.via}(${c.text.length > 100 ? c.text.slice(0, 100) + "…" : c.text})${c.helperLine ? ` via the helper at line ${c.helperLine}` : ""}` };
      let path = c.path;
      let viaBase = false;
      // `${API_URL}/orders`: an unknown base address followed by a path. Match the path, but only as inferred.
      if (path.startsWith("{*}/")) {
        path = path.slice(3);
        viaBase = true;
      }
      if (/^https?:\/\//i.test(path)) {
        let host = null;
        try {
          host = new URL(path.replace(/\{\*\}/g, "x")).host;
        } catch {
          /* not a URL after all */
        }
        if (host && !/^(localhost|127\.0\.0\.1)(:|$)/.test(host)) {
          callStats.external++;
          frontendHosts.set(host, [...(frontendHosts.get(host) ?? []), { file: f.path, line: c.line, url: c.path }]);
          continue;
        }
        path = path.replace(/^https?:\/\/[^/]+/i, "") || "/";
      }
      if (!c.resolved && !viaBase) {
        callStats.dynamic++;
        callStats.unresolved++;
        addEdge(`file:${f.path}`, "unresolved:api", "calls-api", "unresolved", { ...ev, note: `path not worked out: ${c.path}` });
        callRecords.push({ ...c, file: f.path, status: "unresolved", reason: "path built at runtime" });
        continue;
      }
      if (!path.startsWith("/")) path = `/${path}`;
      if (!epList.length) {
        callStats.noBackend++;
        callStats.unresolved++;
        addEdge(`file:${f.path}`, "unresolved:api", "calls-api", "unresolved", { ...ev, note: `${c.method} ${path} (no server routes found in this repository)` });
        callRecords.push({ ...c, file: f.path, status: "unresolved", reason: "no backend in repo" });
        continue;
      }
      const match = matchRoute(c.method, path, epList);
      if (!match.best.length) {
        callStats.unresolved++;
        addEdge(`file:${f.path}`, "unresolved:api", "calls-api", "unresolved", { ...ev, note: `${c.method} ${path} matches no mapped route` });
        callRecords.push({ ...c, file: f.path, status: "unresolved", reason: "no route matches" });
        continue;
      }
      const status = match.best.length === 1 && match.exact && !viaBase ? "verified" : "inferred";
      callStats[status]++;
      for (const ep of match.best) {
        addEdge(`file:${f.path}`, ep.id, "calls-api", status, { ...ev, note: `${c.method} ${path}${status === "inferred" ? ` (${viaBase ? "after an unknown base address" : match.best.length > 1 ? `${match.best.length} routes fit` : "a dynamic segment lines up with a fixed one"})` : ""}` });
        ep.data.callers = (ep.data.callers ?? 0) + 1;
      }
      callRecords.push({ ...c, file: f.path, status, endpoints: match.best.map((e) => e.id) });
    }
  }
  // Screens: switch-based routers, React Router (JSX or objects), and file-based routes (Next.js app/ and pages/).
  addNode({ id: "module:web/screens", type: "module", label: "Screens", parent: "layer:web", layer: "web", desc: "Pages, from the app's router (React Router routes, switch-based routers, Next.js app/ and pages/ folders)" });
  const navItems = new Map();
  for (const f of tsFiles) for (const n of res(f.path).navItems ?? []) navItems.set(n.id, { ...n, file: f.path });
  const addScreen = (id, route, file, line, components, importOf, kind) => {
    const nav = navItems.get(route) ?? navItems.get(route.replace(/^\//, "")) ?? navItems.get(`/${route}`);
    addNode({ id, type: "screen", label: nav?.label ?? route, parent: "module:web/screens", layer: "web", file, line, desc: nav?.summary ?? `${kind === "file" ? "file route" : `route "${route}"`} in ${file.split("/").pop()}`, data: { route, kind, phase: nav?.phase ?? null, nav: nav ? { file: nav.file, line: nav.line } : null, components } });
    for (const comp of components) {
      const target = importOf ? importOf.get(comp) : null;
      if (target) addEdge(id, `file:${target}`, "renders", "verified", { file, line, note: `route "${route}" renders <${comp}>` });
    }
    if (kind === "file") addEdge(id, `file:${file}`, "renders", "verified", { file, line: 1, note: "file-based route" });
  };
  for (const f of tsFiles.filter((x) => x.cls.layer === "web")) {
    const r = res(f.path);
    const importOf = new Map();
    for (const imp of r.imports) for (const name of imp.names) importOf.set(name, resolveImport(f.path, imp.spec));
    // Components defined in the same file render from here too.
    for (const s of r.screens) addScreen(`screen:${f.path}:${s.route}`, s.route, f.path, s.line, s.components, importOf, s.kind);
    // Next.js: app/**/page.tsx and pages/**/*.tsx (not _app, _document or api/).
    const m = /(?:^|\/)(app|pages)\/(.*)$/.exec(f.path);
    if (m && npm.has("next")) {
      const rest = m[2];
      if (m[1] === "app" && /(^|\/)page\.(t|j)sx?$/.test(rest)) addScreen(`screen:${f.path}`, `/${rest.replace(/(^|\/)page\.(t|j)sx?$/, "").replace(/\([^)]*\)\/?/g, "")}`.replace(/\/$/, "") || "/", f.path, 1, [], null, "file");
      if (m[1] === "pages" && !/^(_app|_document|api\/)/.test(rest)) addScreen(`screen:${f.path}`, `/${rest.replace(/\.(t|j)sx?$/, "").replace(/\/?index$/, "")}`, f.path, 1, [], null, "file");
    }
  }
  // Screen -> API reachability through imports (inferred: code is imported, not necessarily called on that screen).
  const fileCalls = new Map();
  for (const e of edges.values()) if (e.kind === "calls-api" && e.status !== "unresolved") {
    const list = fileCalls.get(e.from) ?? [];
    list.push(e.to);
    fileCalls.set(e.from, list);
  }
  const layerOfFile = (p) => byPath.get(p)?.cls.layer;
  for (const s of [...nodes.values()].filter((n) => n.type === "screen")) {
    const start = [...edges.values()].filter((e) => e.from === s.id && e.kind === "renders").map((e) => e.to.slice(5));
    const seen = new Set(start);
    const queue = [...start];
    while (queue.length) {
      const p = queue.shift();
      for (const t of tsImportsOf.get(p) ?? []) {
        if (seen.has(t) || layerOfFile(t) !== "web") continue;
        seen.add(t);
        queue.push(t);
      }
    }
    const reached = new Set();
    for (const p of seen) for (const ep of fileCalls.get(`file:${p}`) ?? []) reached.add(ep);
    for (const ep of reached) addEdge(s.id, ep, "reaches-api", "inferred", { file: s.file, line: s.line, note: "the screen's components import code that calls this address" });
    s.data.filesReached = seen.size;
  }

  // ---------- Permissions, policies & roles ----------
  addNode({ id: "module:security/permissions", type: "module", label: "Permissions & policies", parent: "layer:security", layer: "security", desc: "" });
  addNode({ id: "module:security/roles", type: "module", label: "Roles", parent: "layer:security", layer: "security", desc: "Roles named in the code, and their default permissions" });
  const ROLE = config.backend?.roleEnum ?? null;
  const permEnum = PERM ? cs.flatMap((f) => res(f.path).enums.filter((e) => e.name === PERM).map((e) => ({ f, e })))[0] : null;
  const roleEnum = ROLE ? cs.flatMap((f) => res(f.path).enums.filter((e) => e.name === ROLE).map((e) => ({ f, e })))[0] : null;
  const catalog = new Map();
  for (const f of cs) for (const c of res(f.path).permissionCatalog ?? []) catalog.set(c.permission, { ...c, file: f.path });
  const tsUnion = PERM ? tsFiles.map((f) => ({ f, u: res(f.path).unions?.[PERM] })).find((x) => x.u) : null;
  if (permEnum) {
    for (const m of permEnum.e.members) {
      const cat = catalog.get(m.name);
      addNode({
        id: `perm:${m.name}`,
        type: "permission",
        label: cat?.name ? `#${m.value} ${cat.name}` : `${m.name}`,
        parent: "module:security/permissions",
        layer: "security",
        file: permEnum.f.path,
        line: m.line,
        desc: cat?.description ?? m.summary ?? "",
        data: { kind: "enum", name: m.name, number: m.value, module: cat?.module ?? null, catalog: cat ? { file: cat.file, line: cat.line } : null, catalogExists: catalog.size > 0, inTypeScript: tsUnion ? tsUnion.u.find((x) => x.value === m.name) ?? null : null, tsFile: tsUnion?.f.path ?? null },
      });
    }
  }
  // Authorization policies (AddPolicy) and the roles they require.
  for (const f of cs) {
    for (const p of res(f.path).policies ?? []) {
      addNode({ id: policyId(p.name), type: "permission", label: `Policy: ${p.name}`, parent: "module:security/permissions", layer: "security", file: f.path, line: p.line, desc: [p.roles.length ? `roles ${p.roles.join(", ")}` : "", p.claims.length ? `claims ${p.claims.join(", ")}` : "", p.signedIn ? "signed-in user" : ""].filter(Boolean).join(" · "), data: { kind: "policy", name: p.name } });
      for (const ro of p.roles) addEdge(roleId(ro), policyId(p.name), "default-for", "verified", { file: f.path, line: p.line, note: `AddPolicy("${p.name}", … RequireRole("${ro}"))` });
    }
  }
  const allRoles = roleEnum ? roleEnum.e.members.map((m) => m.name) : [];
  if (roleEnum) for (const m of roleEnum.e.members) addNode({ id: roleId(m.name), type: "role", label: m.name.replace(/_/g, " "), parent: "module:security/roles", layer: "security", file: roleEnum.f.path, line: m.line, desc: m.summary ?? "" });
  const defaultsFile = cs.find((f) => res(f.path).permissionDefaults);
  let defaultsInfo = null;
  if (defaultsFile) {
    const d = res(defaultsFile.path).permissionDefaults;
    defaultsInfo = { file: defaultsFile.path, wrapper: d.wrapper, unresolved: [] };
    for (const entry of d.entries) {
      const roles = entry.roles.includes("*") ? allRoles : entry.roles;
      for (const role of roles) addEdge(roleId(role), `perm:${entry.permission}`, "default-for", "verified", { file: defaultsFile.path, line: entry.line, note: `[${PERM}.${entry.permission}] = ${entry.expr}` });
      if (entry.unresolved.length) defaultsInfo.unresolved.push({ permission: entry.permission, line: entry.line, parts: entry.unresolved });
      if (d.wrapper?.adds && roles.includes(d.wrapper.ifHas) && !roles.includes(d.wrapper.adds)) {
        addEdge(roleId(d.wrapper.adds), `perm:${entry.permission}`, "default-for", "inferred", { file: defaultsFile.path, line: d.wrapper.declLine ?? d.wrapper.line, note: `${d.wrapper.name} adds ${d.wrapper.adds} wherever ${d.wrapper.ifHas} is listed (rule read from the code, not executed)` });
      }
    }
  }
  if (PERM) {
    for (const f of cs) {
      if (f.path === permEnum?.f.path) continue;
      const seen = new Map();
      for (const ref of res(f.path).permissionRefs) if (!seen.has(ref.name)) seen.set(ref.name, ref.line);
      for (const [name, line] of seen) addEdge(`file:${f.path}`, `perm:${name}`, "references", nodes.has(`perm:${name}`) ? "verified" : "unresolved", { file: f.path, line, note: `${PERM}.${name}` });
    }
  }
  // Screens' permission checks: matched to a permission or policy by name.
  for (const f of tsFiles) {
    for (const p of res(f.path).permissionChecks) {
      if (!p.permission) continue;
      const target = nodes.has(`perm:${p.permission}`) ? `perm:${p.permission}` : nodes.has(policyId(p.permission)) ? policyId(p.permission) : `perm:${p.permission}`;
      addEdge(`file:${f.path}`, target, "checks-permission", "verified", { file: f.path, line: p.line, note: `${p.via}("${p.permission}")` });
    }
  }
  // Anything an edge points at but nobody declared: roles named only in [Authorize(Roles)] / IsInRole / RequireRole,
  // policies used but not defined here, permissions only the screens know.
  for (const e of [...edges.values()]) {
    if (nodes.has(e.to) && nodes.has(e.from)) continue;
    for (const id of [e.from, e.to]) {
      if (nodes.has(id)) continue;
      if (id.startsWith("role:")) addNode({ id, type: "role", label: id.slice(5), parent: "module:security/roles", layer: "security", desc: "Named in the code; not declared as an enum member", data: { declared: false } });
      else if (id.startsWith("perm:policy:")) addNode({ id, type: "permission", label: `Policy: ${id.slice(12)}`, parent: "module:security/permissions", layer: "security", desc: "Used, but no AddPolicy for it was found", data: { kind: "policy", name: id.slice(12), undefinedPolicy: true } });
      else if (id.startsWith("perm:")) addNode({ id, type: "permission", label: id.slice(5), parent: "module:security/permissions", layer: "security", desc: "Named in the code, but not a member of a configured permission enum", data: { kind: "name", name: id.slice(5), undeclared: true } });
    }
  }

  // ---------- External services ----------
  const hostNodes = new Map();
  const addHost = (host, file, line, url, via) => {
    const id = `ext:${host}`;
    if (!hostNodes.has(id)) {
      hostNodes.set(id, true);
      addNode({ id, type: "integration", label: host, parent: "layer:external", layer: "external", file, line, desc: `Called over HTTP. Address found in ${file.split("/").pop()}.`, data: { url } });
    }
    addEdge(`file:${file}`, id, "calls-external", "verified", { file, line, note: `${via}"${url}"` });
  };
  // Outside services come from application code only: tests use made-up hosts.
  for (const f of cs.filter((x) => x.cls.layer !== "tests")) {
    for (const u of res(f.path).urls) {
      let host;
      try {
        host = new URL(u.url).host;
      } catch {
        continue;
      }
      if (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) || /(^|\.)(example\.(com|org|net)|test|invalid|w3\.org|schemas\.\w+|xmlsoap\.org|microsoft\.com\/(?:winfx|xml))$/.test(host)) {
        (nodes.get(`file:${f.path}`).data.localUrls ??= []).push({ url: u.url, line: u.line });
        continue;
      }
      addHost(host, f.path, u.line, u.url, "");
    }
    for (const sct of res(f.path).configSections) (nodes.get(`file:${f.path}`).data.configSections ??= []).push(sct);
  }
  for (const [host, uses] of frontendHosts) for (const u of uses) addHost(host, u.file, u.line, u.url, "fetch ");
  const nuget = new Map();
  for (const f of files.filter((x) => res(x.path)?.kind === "project")) {
    const r = res(f.path);
    for (const p of r.packages) {
      const id = `pkg:nuget:${p.name}`;
      addNode({ id, type: "package", label: p.name, parent: "module:external/nuget", layer: "external", file: f.path, line: p.line, desc: p.version ? `${p.version}` : "" });
      addEdge(`file:${f.path}`, id, "declares", "verified", { file: f.path, line: p.line, note: `<PackageReference Include="${p.name}"${p.version ? ` Version="${p.version}"` : ""}>` });
      if (!nuget.has(p.name)) nuget.set(p.name, { file: f.path, line: p.line });
    }
    for (const ref of r.projectRefs) {
      const target = posix.normalize(posix.join(posix.dirname(f.path), ref.include));
      addEdge(`file:${f.path}`, byPath.has(target) ? `file:${target}` : null, "project-ref", "verified", { file: f.path, line: ref.line, note: `<ProjectReference Include="${ref.include}">` });
    }
  }
  // Well-known packages stand for an outside service (Npgsql → PostgreSQL, Stripe.net → Stripe, ...).
  const dbServers = [];
  for (const svc of knownServices([...nuget.keys()].map((n) => ({ name: n, eco: "nuget", ...nuget.get(n) })).concat([...npm].map(([n, p]) => ({ name: n, eco: "npm", file: p.file, line: p.line })) ))) {
    const id = `ext:svc:${svc.id}`;
    if (!nodes.has(id)) addNode({ id, type: "integration", label: svc.label, parent: "layer:external", layer: "external", file: svc.file, line: svc.line, desc: `${svc.kind === "database" ? "Database server" : "Outside service"}, known from the package ${svc.package}`, data: { packages: [] } });
    nodes.get(id).data.packages.push(svc.package);
    addEdge(`pkg:${svc.eco}:${svc.package}`, id, "connects", "inferred", { file: svc.file, line: svc.line, note: `the package ${svc.package} is the client for ${svc.label}` });
    if (svc.kind === "database") dbServers.push(id);
  }
  for (const id of new Set(dbServers)) addEdge(id, "module:database/schema", "hosts", "inferred", { file: nodes.get(id).file, line: nodes.get(id).line ?? 1, note: "the database driver in use; the schema comes from the migrations or EF Core" });

  // ---------- Tests ----------
  for (const f of cs.filter((x) => x.cls.layer === "tests")) {
    const r = res(f.path);
    nodes.get(`file:${f.path}`).data.tests = r.tests;
    const seen = new Set();
    for (const lit of r.routeLiterals) {
      const path = lit.value.split("?")[0];
      for (const verb of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
        const m = matchRoute(verb, path, epList);
        if (m.best.length === 1 && m.exact && !seen.has(m.best[0].id)) {
          seen.add(m.best[0].id);
          addEdge(`file:${f.path}`, m.best[0].id, "tests", "inferred", { file: f.path, line: lit.line, note: `"${lit.value}" (route literal in a test; HTTP verb not checked)` });
          m.best[0].data.testedBy = (m.best[0].data.testedBy ?? 0) + 1;
        }
      }
    }
  }
  for (const f of tsFiles.filter((x) => x.cls.layer === "tests")) {
    for (const c of res(f.path).apiCalls) {
      const m = c.resolved ? matchRoute(c.method, c.path.startsWith("/") ? c.path : `/${c.path}`, epList) : { best: [] };
      for (const ep of m.best) {
        addEdge(`file:${f.path}`, ep.id, "tests", "inferred", { file: f.path, line: c.line, note: `${c.method} ${c.path} called from a test` });
        ep.data.testedBy = (ep.data.testedBy ?? 0) + 1;
      }
    }
  }

  // ---------- Docs ----------
  const basenames = new Map();
  for (const f of files) {
    const b = f.path.split("/").pop();
    basenames.set(b, [...(basenames.get(b) ?? []), f.path]);
  }
  const docMissing = [];
  for (const f of files.filter((x) => res(x.path)?.kind === "markdown")) {
    for (const m of res(f.path).mentions) {
      if (m.kind === "path") {
        const raw = m.target.replace(/^\.\//, "");
        const relative = posix.normalize(posix.join(posix.dirname(f.path), m.target));
        const target = byPath.has(raw) ? raw : byPath.has(relative) ? relative : null;
        if (target) addEdge(`file:${f.path}`, `file:${target}`, "mentions", "verified", { file: f.path, line: m.line, note: m.target });
        else {
          // "Features/Jobs/JobStateMachine.cs": a partial path; one repo file ending with it is a likely match.
          const tail = raw.replace(/^(\.\.\/)+/, "");
          const hits = files.filter((x) => x.path.endsWith(`/${tail}`));
          if (hits.length === 1) addEdge(`file:${f.path}`, `file:${hits[0].path}`, "mentions", "inferred", { file: f.path, line: m.line, note: `${m.target} (partial path)` });
          else if (!hits.length && !/[[\]*<>{}]/.test(raw) && !/^(https?:|node_modules)/.test(raw)) docMissing.push({ file: f.path, line: m.line, target: m.target });
        }
      } else {
        const hits = basenames.get(m.target) ?? [];
        if (hits.length === 1) addEdge(`file:${f.path}`, `file:${hits[0]}`, "mentions", "inferred", { file: f.path, line: m.line, note: `file name ${m.target}` });
      }
    }
  }

  // ---------- Workflow ----------
  const wfDoc = workflowMap?.source ? files.find((f) => f.path === workflowMap.source && res(f.path)?.steps?.length) : null;
  const steps = wfDoc ? res(wfDoc.path).steps : [];
  const workflowNote = !workflowMap ? "not configured" : !files.some((f) => f.path === workflowMap.source) ? `source ${workflowMap.source} not found` : !steps.length ? `no numbered steps found in ${workflowMap.source}` : null;
  for (const s of steps) {
    const rule = workflowMap?.steps?.find((x) => x.number === s.number);
    const id = `step:${s.number}`;
    addNode({ id, type: "step", label: `${s.number}. ${s.name}`, parent: "layer:workflow", layer: "workflow", file: wfDoc.path, line: s.line, desc: s.detail, data: { who: s.who, number: s.number, keywords: rule?.keywords ?? [], note: rule?.note ?? null } });
    if (s.number > 1) addEdge(`step:${s.number - 1}`, id, "next-step", "verified", { file: wfDoc.path, line: s.line, note: "order of the steps in the document" });
    for (const kw of rule?.keywords ?? []) {
      const re = new RegExp(`(^|[^a-z])${kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
      for (const n of nodes.values()) {
        if (n.type !== "module" || !["web", "api", "infrastructure", "domain"].includes(n.layer)) continue;
        if (re.test(n.label) || re.test(n.id)) addEdge(id, n.id, "step-in", "inferred", { file: CONFIG_NAME, line: 1, note: `keyword "${kw}" matches the module name (mapping kept in ${CONFIG_NAME})` });
      }
      for (const n of nodes.values()) {
        if (n.type === "endpoint" && re.test(n.data.route ?? "")) addEdge(id, n.id, "step-endpoint", "inferred", { file: CONFIG_NAME, line: 1, note: `keyword "${kw}" in the route` });
      }
    }
  }
  const statusEnums = cs.flatMap((f) => res(f.path).enums.filter((e) => /(Status|State)$/.test(e.name)).map((e) => ({ name: e.name, file: f.path, line: e.line, members: e.members.map((m) => ({ name: m.name, line: m.line, summary: m.summary })) })));

  // ---------- Areas (functional modules) ----------
  const areas = buildAreas(nodes, edges);

  // ---------- Descriptions and counts ----------
  const childCount = new Map();
  for (const n of nodes.values()) if (n.parent) childCount.set(n.parent, (childCount.get(n.parent) ?? 0) + 1);
  for (const n of nodes.values()) n.childCount = childCount.get(n.id) ?? 0;
  for (const n of nodes.values()) {
    if (n.type !== "module" || n.desc) continue;
    const kids = [...nodes.values()].filter((k) => k.parent === n.id && k.type === "file" && k.desc && !k.desc.startsWith("Not analyzed"));
    kids.sort((a, b) => (b.data.lines ?? 0) - (a.data.lines ?? 0));
    if (kids[0]) {
      n.desc = kids[0].desc;
      n.data.descFrom = kids[0].file;
    }
  }
  const epNodes = [...nodes.values()].filter((n) => n.type === "endpoint");
  const layerDesc = {
    web: `${tsFiles.filter((f) => f.cls.layer === "web").length} script files, ${[...nodes.values()].filter((n) => n.type === "screen").length} screens, ${callStats.total} HTTP call sites`,
    api: `${epNodes.length} addresses in ${new Set(epNodes.map((e) => e.file)).size} files; ${epNodes.filter((e) => e.data.auth?.level === "permission-route").length} guarded by a permission, policy or role on the route`,
    infrastructure: `${cs.filter((f) => f.cls.layer === "infrastructure").length} C# files; SQL touches ${new Set([...edges.values()].filter((e) => ["reads", "writes", "reads-writes"].includes(e.kind)).map((e) => e.to)).size} tables`,
    domain: `${cs.filter((f) => f.cls.layer === "domain").length} C# files, ${[...nodes.values()].filter((n) => n.type === "type" && n.layer === "domain").length} types`,
    database: `${schema.tables.length} tables, ${schema.tables.reduce((a, t) => a + t.fks.length, 0)} foreign keys, ${migrations.length} migrations`,
    external: `${[...nodes.values()].filter((n) => n.type === "integration").length} services, ${npm.size} npm and ${nuget.size} NuGet packages`,
    security: `${[...nodes.values()].filter((n) => n.type === "permission").length} permissions and policies, ${[...nodes.values()].filter((n) => n.type === "role").length} roles`,
    tests: `${cs.filter((f) => f.cls.layer === "tests").reduce((a, f) => a + res(f.path).tests.methods, 0)} C# test methods, ${tsFiles.filter((f) => f.cls.layer === "tests").length} frontend test files`,
    docs: `${files.filter((f) => f.cls.layer === "docs").length} Markdown files`,
    workflow: steps.length ? `${steps.length} steps from ${workflowMap.source}` : `Workflow ${workflowNote}`,
  };
  for (const [k, v] of Object.entries(layerDesc)) {
    const n = nodes.get(`layer:${k}`);
    if (n) n.data.stats = v;
  }

  // ---------- Git changes ----------
  const changed = new Map();
  for (const c of git?.changed ?? []) changed.set(c.path, c.status);
  for (const n of nodes.values()) {
    if (n.type === "file" && changed.has(n.file)) n.changed = changed.get(n.file);
  }

  return {
    nodes: Object.fromEntries(nodes),
    edges: [...edges.values()],
    areas,
    schemaInfo: { unmodeled: schema.unmodeled, dropped: schema.dropped, counts: schema.counts, functions: schema.functions, sqlUnknown },
    callStats,
    callRecords,
    endpointNotes,
    unresolvedImports,
    docMissing,
    fallback: fallbackEvidence,
    defaultsInfo,
    statusEnums,
    workflow: { source: workflowMap?.source ?? null, steps: steps.length, mapFile: CONFIG_NAME, note: workflowNote },
    typeRefCandidates,
    diTypes: [...diTypes],
    notes,
  };
}

const CONFIG_NAME = ".architecture-explorer.json";
const rank = (s) => (s === "verified" ? 3 : s === "inferred" ? 2 : 1);

export function joinRoute(prefix, pattern) {
  const p = `${prefix ?? ""}/${pattern ?? ""}`.replace(/\/{2,}/g, "/");
  return p.length > 1 ? p.replace(/\/$/, "") : p;
}

function describeAuth(a) {
  switch (a.level) {
    case "anonymous": return "Open to anyone (AllowAnonymous)";
    case "no-auth-found": return "No authorization found: open unless something the scan can't see protects it";
    case "permission-route": return `Needs ${a.routeAuth.filter((p) => p.kind !== "signed-in").map((p) => (p.kind === "role" ? `role ${p.name}` : p.kind === "policy" ? `policy ${p.name}` : p.name)).join(", ")}`;
    case "permission-handler": return `Checks ${[...new Set(a.handlerRequires.filter((x) => x.permission).map((x) => x.permission))].join(", ")} in the handler`;
    case "permission-domain": return `Business rules check ${[...new Set(a.handlerRequires.filter((x) => x.permission).map((x) => x.permission))].join(", ")}`;
    case "permission-allows": return `Branches on ${[...new Set(a.handlerAllows.map((x) => x.permission ?? (x.role ? `role ${x.role}` : x.policy ? `policy ${x.policy}` : null)).filter(Boolean))].join(", ")}`;
    case "signed-in": return "Any signed-in user";
    default: return "";
  }
}

/** Matches a call path ("/api/jobs/{*}/notes") against mapped routes. */
export function matchRoute(method, path, endpoints) {
  const segs = path.split("/").filter(Boolean);
  let best = [];
  let bestScore = -1;
  let bestExact = false;
  for (const ep of endpoints) {
    if (method !== "?" && ep.data.verb !== method) continue;
    const esegs = ep.data.route.split("/").filter(Boolean);
    const catchAll = esegs.length && /^\{\*/.test(esegs[esegs.length - 1]);
    if (esegs.length !== segs.length && !(catchAll && segs.length >= esegs.length - 1)) continue;
    let score = 0;
    let exact = true;
    let ok = true;
    for (let i = 0; i < esegs.length && ok; i++) {
      const e = esegs[i];
      const c = segs[i];
      if (c === undefined) break;
      const eParam = /^\{[^}]+\}$/.test(e);
      const eMixed = !eParam && e.includes("{");
      const cWild = c === "{*}";
      const cMixed = !cWild && c.includes("{*}");
      // Scores: fixed = fixed 2, value = parameter 1, dynamic over a fixed segment 0 (and not exact).
      if (eParam) {
        if (cMixed) exact = false;
        else score++;
        continue;
      }
      if (eMixed) {
        const re = new RegExp(`^${e.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{[^}]+\\?\}/g, "[^/]+")}$`, "i");
        if (cWild || cMixed) exact = false;
        else if (!re.test(c)) ok = false;
        continue;
      }
      if (cWild) {
        exact = false;
        continue;
      }
      if (cMixed) {
        const re = new RegExp(`^${c.split("{*}").map((x) => x.replace(/[.*+?^$()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
        if (re.test(e)) {
          exact = false;
          continue;
        }
        ok = false;
        continue;
      }
      if (e.toLowerCase() === c.toLowerCase()) score += 2;
      else ok = false;
    }
    if (!ok) continue;
    if (score > bestScore) {
      best = [ep];
      bestScore = score;
      bestExact = exact;
    } else if (score === bestScore) {
      best.push(ep);
      bestExact = bestExact && exact;
    }
  }
  return { best, exact: bestExact };
}

/**
 * Functional areas: a backend feature folder (Features/Orders in Api, Infrastructure, Domain and tests) is one area
 * by naming convention. A web module joins the area it calls most (verified calls), else the one with its name.
 */
function buildAreas(nodes, edges) {
  const areas = new Map();
  const norm = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const ensure = (key, label) => {
    if (!areas.has(key)) areas.set(key, { id: `area:${key}`, label, modules: [], reasons: {} });
    return areas.get(key);
  };
  for (const n of nodes.values()) {
    if (n.type !== "module") continue;
    if (["api", "infrastructure", "domain"].includes(n.layer) || (n.layer === "tests" && /^module:tests\/(api|infrastructure|domain)\//.test(n.id))) {
      const f = n.data.feature ?? n.label;
      if (!f || f === "(root)") continue;
      const a = ensure(norm(f), f);
      a.modules.push(n.id);
      a.reasons[n.id] = `folder Features/${f} (or ${f}/) — same name across projects`;
    }
  }
  const parentOf = (id) => nodes.get(id)?.parent;
  const moduleOf = (id) => {
    let cur = id;
    while (cur && nodes.get(cur)?.type !== "module") cur = parentOf(cur);
    return cur;
  };
  const moduleToArea = new Map();
  for (const a of areas.values()) for (const m of a.modules) moduleToArea.set(m, a);
  for (const n of nodes.values()) {
    if (n.type !== "module" || n.layer !== "web" || n.id === "module:web/screens") continue;
    const tally = new Map();
    for (const e of edges.values()) {
      if (e.kind !== "calls-api" || e.status === "unresolved") continue;
      if (moduleOf(e.from) !== n.id) continue;
      const a = moduleToArea.get(moduleOf(e.to));
      if (a) tally.set(a, (tally.get(a) ?? 0) + e.count);
    }
    const sorted = [...tally].sort((x, y) => y[1] - x[1]);
    const byName = areas.get(norm(n.data.feature ?? n.label));
    if (sorted.length && !(sorted[0][0].label === "Auth" && byName)) {
      sorted[0][0].modules.push(n.id);
      sorted[0][0].reasons[n.id] = `calls ${sorted[0][1]} address${sorted[0][1] === 1 ? "" : "es"} of ${sorted[0][0].label} (most of its calls)`;
    } else if (byName) {
      byName.modules.push(n.id);
      byName.reasons[n.id] = "same folder name";
    } else {
      const a = ensure(`web-${norm(n.label)}`, `${n.label} (web only)`);
      a.modules.push(n.id);
      a.reasons[n.id] = "calls no API address the scanner matched";
    }
  }
  return [...areas.values()].filter((a) => a.modules.length);
}

// Health findings (things worth a look, each with file and line) and scanning coverage (what was read, what was
// matched, what was left over). Findings never claim more than the code shows: "only checks sign-in" is a fact,
// "insecure" would be a guess, so the wording says what was found and when it is fine.

export function computeHealth({ graph, files, results, scanErrors, gitInfo, config }) {
  const nodes = graph.nodes;
  const all = Object.values(nodes);
  const endpoints = all.filter((n) => n.type === "endpoint");
  const findings = [];
  const add = (f) => findings.push({ id: `f${findings.length + 1}`, ...f });
  const ev = (n, note) => ({ file: n.file, line: n.line, note: note ?? n.label, node: n.id });

  // Secrets in settings files.
  for (const f of files) {
    const r = results.get(f.path);
    if (r?.kind === "json" && r.secrets?.length) {
      add({
        severity: "important",
        category: "Secrets",
        title: `A secret-looking value is written into ${f.path.split("/").pop()}`,
        detail: `${r.secrets.map((s) => s.key).join(", ")} ${r.secrets.length === 1 ? "has" : "have"} a value in a file that is in the repository. Keys usually belong in user secrets or environment variables, not in the repository. Values are masked here.`,
        evidence: r.secrets.map((s) => ({ file: f.path, line: s.line, note: s.key })),
      });
    }
  }

  // Route resolution problems.
  const dupes = endpoints.filter((e) => e.data.duplicateOf);
  if (dupes.length) add({ severity: "important", category: "API", title: `${dupes.length} route${dupes.length > 1 ? "s are" : " is"} mapped twice`, detail: "Two Map calls produce the same verb and path; ASP.NET Core rejects ambiguous matches at run time.", evidence: dupes.map((d) => ev(d, `${d.data.verb} ${d.data.route}, also at ${nodes[d.data.duplicateOf]?.file}:${nodes[d.data.duplicateOf]?.line}`)) });
  const unresolvedRoutes = endpoints.filter((e) => !e.data.resolved);
  if (unresolvedRoutes.length) add({ severity: "review", category: "Coverage", title: `${unresolvedRoutes.length} route${unresolvedRoutes.length > 1 ? "s" : ""} couldn't be fully worked out`, detail: "The scanner couldn't follow the group prefix or the pattern to a literal. These addresses are shown with {?}.", evidence: unresolvedRoutes.map((e) => ev(e, e.data.prefixReason)) });

  // Security: who can call what.
  const writes = endpoints.filter((e) => ["POST", "PUT", "PATCH", "DELETE"].includes(e.data.verb));
  const signedInOnly = writes.filter((e) => e.data.auth?.level === "signed-in");
  if (signedInOnly.length) {
    add({
      severity: "review",
      category: "Permissions",
      title: `${signedInOnly.length} addresses that change data only check that someone is signed in`,
      detail: `No permission, policy or role on the route, and no permission check anywhere in what the handler calls (helpers, stores and business rules, four levels deep), so every signed-in user can use them. That is right for things everyone may do (changing your own password, for example); anything else needs a policy or permission.`,
      evidence: signedInOnly.map((e) => ev(e, `${e.data.verb} ${e.data.route}`)),
    });
  }
  const allowsOnly = writes.filter((e) => e.data.auth?.level === "permission-allows");
  if (allowsOnly.length) {
    add({
      severity: "info",
      category: "Permissions",
      title: `${allowsOnly.length} addresses that change data rely on a permission test (a branch), not an enforced check`,
      detail: "Somewhere in what the handler calls, Allows decides a branch. Usually that is the gate (AsManager → CompanyManagers.Includes refuses without the permission), but an Allows inside a page builder only changes what is shown. Each entry names the chain so you can check which it is.",
      evidence: allowsOnly.map((e) => ev(e, `${e.data.verb} ${e.data.route} — ${[...new Set(e.data.auth.handlerAllows.filter((x) => x.permission).map((x) => `${x.permission} via ${x.via.split(" → ").slice(1).join(" → ") || "handler"}`))].slice(0, 2).join("; ")}`)),
    });
  }
  const inferredOnly = writes.filter((e) => ["permission-domain", "permission-handler-computed"].includes(e.data.auth?.level) && e.data.auth.handlerRequires.every((r) => r.inferred));
  if (inferredOnly.length) {
    add({
      severity: "info",
      category: "Coverage",
      title: `${inferredOnly.length} permission checks were found through a name-matched call`,
      detail: "The check is real code, but one call on the way to it (for example job.Progress.Complete → JobProgress.Complete) was matched by method name, not by type. Shown as inferred.",
      evidence: inferredOnly.map((e) => ev(e, `${e.data.verb} ${e.data.route} — ${e.data.auth.handlerRequires.map((r) => r.permission ?? "permission chosen at run time").filter((v, i, a) => a.indexOf(v) === i).join(", ")}`)),
    });
  }
  const noAuth = endpoints.filter((e) => e.data.auth?.level === "no-auth-found");
  const noAuthWrites = noAuth.filter((e) => ["POST", "PUT", "PATCH", "DELETE"].includes(e.data.verb));
  if (noAuthWrites.length) add({ severity: "important", category: "Permissions", title: `${noAuthWrites.length} addresses that change data have no authorization the scan can find`, detail: "ASP.NET Core leaves an address open unless something requires authorization: [Authorize], RequireAuthorization(), or a fallback policy (AddAuthorizationBuilder().SetFallbackPolicy(...)). None was found for these. Middleware or a gateway the scan can't see may still protect them.", evidence: noAuthWrites.map((e) => ev(e, `${e.data.verb} ${e.data.route}`)) });
  const noAuthReads = noAuth.filter((e) => !noAuthWrites.includes(e));
  if (noAuthReads.length) add({ severity: "review", category: "Permissions", title: `${noAuthReads.length} addresses that read data have no authorization the scan can find`, detail: "Fine for public pages and health checks; otherwise anyone who finds the address can read the data.", evidence: noAuthReads.map((e) => ev(e, `${e.data.verb} ${e.data.route}`)) });
  const computed = endpoints.filter((e) => /computed/.test(e.data.auth?.level ?? ""));
  if (computed.length) add({ severity: "info", category: "Permissions", title: `${computed.length} addresses choose their permission at run time`, detail: "The permission is a variable (for example the job action being done), so the explorer can't name it. The check itself is there.", evidence: computed.map((e) => ev(e, `${e.data.verb} ${e.data.route}`)) });
  const anon = endpoints.filter((e) => e.data.auth?.level === "anonymous");
  if (anon.length) add({ severity: "info", category: "Permissions", title: `${anon.length} addresses are open without sign-in`, detail: "Marked AllowAnonymous. Expected for sign-in and the customer's signing link; each should check its own token.", evidence: anon.map((e) => ev(e, `${e.data.verb} ${e.data.route}`)) });

  // Web <-> API.
  const noRoute = graph.callRecords.filter((c) => c.status === "unresolved" && c.reason === "no route matches");
  if (noRoute.length) add({ severity: "important", category: "API", title: `${noRoute.length} web call${noRoute.length > 1 ? "s" : ""} match no API route`, detail: "The screen calls an address the API doesn't map (or maps with another verb). Either the call is broken or the route lives somewhere the scanner can't follow.", evidence: noRoute.map((c) => ({ file: c.file, line: c.line, note: `${c.method} ${c.path}` })) });
  const dynamic = graph.callRecords.filter((c) => c.status === "unresolved" && c.reason !== "no route matches");
  if (dynamic.length) add({ severity: "minor", category: "Coverage", title: `${dynamic.length} web call${dynamic.length > 1 ? "s" : ""} build their path at run time`, detail: "The path comes from a variable the explorer can't follow inside the file, so these calls aren't linked to a route.", evidence: dynamic.map((c) => ({ file: c.file, line: c.line, note: c.text })) });
  const orphan = endpoints.filter((e) => e.data.resolved && !e.data.callers && !e.data.testedBy && e.data.auth?.level !== "anonymous" && !/\/health$/.test(e.data.route));
  if (orphan.length) add({ severity: "minor", category: "API", title: `${orphan.length} addresses with no caller found in the web app or tests`, detail: "Nothing in the frontend calls them and no test names their path. They may be unused, used by a path built at run time, or tested through a helper.", evidence: orphan.map((e) => ev(e, `${e.data.verb} ${e.data.route}`)) });
  const noHandler = endpoints.filter((e) => e.data.handler?.unresolved);
  if (noHandler.length) add({ severity: "review", category: "Coverage", title: `${noHandler.length} handlers the scanner couldn't locate`, detail: "The guard checks inside these handlers were not analyzed.", evidence: noHandler.map((e) => ev(e)) });

  // Permissions bookkeeping (only when the project declares a permission enum).
  // Declared permissions only: enum members and policies defined with AddPolicy (not names only the screens use).
  const perms = all.filter((n) => n.type === "permission" && (n.data.kind === "enum" || (n.data.kind === "policy" && !n.data.undefinedPolicy)));
  const usedPerms = new Set(graph.edges.filter((e) => ["guarded-by", "checked-in-handler", "checks-permission", "conditional-on"].includes(e.kind)).map((e) => e.to));
  const noCatalog = perms.filter((p) => p.data.kind === "enum" && p.data.catalogExists && !p.data.catalog);
  if (noCatalog.length) add({ severity: "important", category: "Permissions", title: `${noCatalog.length} permission${noCatalog.length > 1 ? "s are" : " is"} missing from PermissionCatalog.cs`, detail: "Step 2 of the permission rule. PermissionCatalogTests fails until it is added.", evidence: noCatalog.map((p) => ev(p)) });
  const noTs = perms.filter((p) => p.data.tsFile && !p.data.inTypeScript);
  if (noTs.length) add({ severity: "important", category: "Permissions", title: `${noTs.length} permission${noTs.length > 1 ? "s are" : " is"} missing from the frontend's permission list (${noTs[0].data.tsFile.split("/").pop()})`, detail: "The screens can't ask for it by name.", evidence: noTs.map((p) => ev(p)) });
  const serverKinds = new Set(["guarded-by", "checked-in-handler", "conditional-on"]);
  const serverChecked = new Set(graph.edges.filter((e) => serverKinds.has(e.kind)).map((e) => e.to));
  const refsOutsideDefinition = new Map();
  for (const e of graph.edges) {
    if (e.kind !== "references") continue;
    const file = e.from.slice(5);
    if (file === perms.find((p) => p.id === e.to)?.file || graph.permissionCatalogFiles?.includes(file) || /(^|\/)tests?\//i.test(file)) continue;
    refsOutsideDefinition.set(e.to, [...(refsOutsideDefinition.get(e.to) ?? []), { file, line: e.evidence[0]?.line }]);
  }
  const notEnforced = perms.filter((p) => !serverChecked.has(p.id));
  if (notEnforced.length) {
    add({
      severity: "review",
      category: "Permissions",
      title: `${notEnforced.length} permission${notEnforced.length > 1 ? "s have" : " has"} no server check the explorer can find`,
      detail: "No route guard, and no permission check reached from any handler names it. Giving or refusing it to one person would then change nothing on the server. It may be checked through code the explorer can't follow (a variable permission, or a domain object loaded at run time) — each entry lists the other places that name it.",
      evidence: notEnforced.map((p) => ev(p, `${p.label}${refsOutsideDefinition.get(p.id) ? ` — also named in ${refsOutsideDefinition.get(p.id).map((r) => `${r.file.split("/").pop()}:${r.line}`).join(", ")}` : " — named nowhere else in app code"}`)),
    });
  }
  const unused = perms.filter((p) => serverChecked.has(p.id) && !usedPerms.has(p.id));
  if (unused.length) add({ severity: "info", category: "Permissions", title: `${unused.length} permission${unused.length > 1 ? "s" : ""} not used by any route guard, handler check or screen`, detail: "Reserved for later or checked another way.", evidence: unused.map((p) => ev(p)) });
  const tsUnion = all.find((n) => n.type === "permission")?.data.tsFile;
  if (tsUnion) {
    const known = new Set(perms.map((p) => p.data.name));
    const r = results.get(tsUnion);
    const extra = (r?.unions?.[config?.backend?.permissionEnum] ?? []).filter((v) => !known.has(v.value));
    if (extra.length) add({ severity: "important", category: "Permissions", title: `${tsUnion.split("/").pop()} lists ${extra.length} permission${extra.length > 1 ? "s" : ""} the server doesn't have`, detail: "The screen would ask for a permission the API never grants.", evidence: extra.map((v) => ({ file: tsUnion, line: v.line, note: v.value })) });
  }
  const undefinedPolicies = all.filter((n) => n.type === "permission" && n.data.undefinedPolicy);
  if (undefinedPolicies.length) add({ severity: "review", category: "Permissions", title: `${undefinedPolicies.length} authorization polic${undefinedPolicies.length > 1 ? "ies are" : "y is"} used but never defined with AddPolicy`, detail: "ASP.NET Core throws at run time when an endpoint asks for a policy nobody registered, unless a custom policy provider supplies it.", evidence: undefinedPolicies.flatMap((p) => graph.edges.filter((e) => e.to === p.id).slice(0, 5).map((e) => ({ file: e.evidence[0]?.file, line: e.evidence[0]?.line, note: `${p.data.name} — ${graph.nodes[e.from]?.label ?? e.from}`, node: e.from }))) });
  const screenOnly = all.filter((n) => n.type === "permission" && n.data.undeclared && graph.edges.some((e) => e.to === n.id && e.kind === "checks-permission"));
  if (screenOnly.length && config?.backend?.permissionEnum) add({ severity: "review", category: "Permissions", title: `Screens check ${screenOnly.length} permission name${screenOnly.length > 1 ? "s" : ""} the server doesn't define`, detail: `They are not members of ${config.backend.permissionEnum} and not policies, so the server can never grant them.`, evidence: screenOnly.flatMap((p) => graph.edges.filter((e) => e.to === p.id).slice(0, 3).map((e) => ({ file: e.evidence[0]?.file, line: e.evidence[0]?.line, note: p.data.name }))) });
  if (config?.error) add({ severity: "important", category: "Coverage", title: "The explorer's config file couldn't be read", detail: `${config.error}. The scan used the defaults.`, evidence: [] });
  if (graph.defaultsInfo?.unresolved?.length) add({ severity: "review", category: "Coverage", title: "Some default roles couldn't be read", detail: "These entries use an expression the explorer doesn't evaluate.", evidence: graph.defaultsInfo.unresolved.map((u) => ({ file: graph.defaultsInfo.file, line: u.line, note: `${u.permission}: ${u.parts.join(", ")}` })) });

  // Database: tenant isolation.
  const tables = all.filter((n) => n.type === "table");
  // Only when the schema uses row-level security at all: tables with the same tenant column but no policy stand out.
  const TENANT = /^(tenant|org|organization|organisation|account|company|workspace|team)_?id$/i;
  const withPolicies = tables.filter((t) => t.data.policies.length);
  const tenantTables = withPolicies.length ? tables.filter((t) => t.data.columns.some((c) => TENANT.test(c.name))) : [];
  const noPolicy = tenantTables.filter((t) => !t.data.policies.length && !t.data.dynamic.some((d) => d.policy));
  const dynamicPolicy = tenantTables.filter((t) => !t.data.policies.length && t.data.dynamic.some((d) => d.policy));
  if (noPolicy.length) add({ severity: "important", category: "Database", title: `${noPolicy.length} tenant tables have no row-level security policy`, detail: `${withPolicies.length} tables use row-level security, but these have a tenant column and no policy; a query that forgets its tenant filter could read another tenant's rows.`, evidence: noPolicy.map((t) => ev(t)) });
  if (dynamicPolicy.length) add({ severity: "info", category: "Coverage", title: `${dynamicPolicy.length} tables get their policy from a DO block`, detail: "The policy is created with dynamic SQL (EXECUTE in a loop), which the explorer doesn't run. It is probably there; it can't be confirmed from the text.", evidence: dynamicPolicy.map((t) => ({ file: t.data.dynamic[0].file, line: t.data.dynamic[0].line, note: t.label, node: t.id })) });
  const noRls = tables.filter((t) => t.data.policies.length && !t.data.rls && !t.data.dynamic.some((d) => d.rls));
  if (noRls.length) add({ severity: "important", category: "Database", title: `${noRls.length} tables have a policy but row-level security isn't enabled`, detail: "A policy does nothing until ALTER TABLE … ENABLE ROW LEVEL SECURITY.", evidence: noRls.map((t) => ev(t)) });

  // Migrations.
  const migs = files.filter((f) => results.get(f.path)?.kind === "migration").map((f) => ({ path: f.path, n: results.get(f.path).number })).filter((m) => m.n);
  const nums = migs.map((m) => Number(m.n)).sort((a, b) => a - b);
  const dupNums = nums.filter((n, i) => nums.indexOf(n) !== i);
  const gaps = [];
  for (let i = 1; i < nums.length; i++) for (let k = nums[i - 1] + 1; k < nums[i]; k++) gaps.push(k);
  if (dupNums.length) add({ severity: "important", category: "Database", title: `Migration number used twice: ${[...new Set(dupNums)].join(", ")}`, detail: "Two migrations share a number; the order they run in depends on file names.", evidence: migs.filter((m) => dupNums.includes(Number(m.n))).map((m) => ({ file: m.path, line: 1 })) });
  if (gaps.length) add({ severity: "minor", category: "Database", title: `Missing migration numbers: ${gaps.map((g) => String(g).padStart(4, "0")).join(", ")}`, detail: "A gap in the sequence.", evidence: [] });

  // Docs pointing at files that aren't there.
  if (graph.docMissing.length) add({ severity: "minor", category: "Docs", title: `${graph.docMissing.length} file paths in the docs don't exist`, detail: "Renamed or moved files, or files planned but not written yet.", evidence: graph.docMissing.slice(0, 200).map((d) => ({ file: d.file, line: d.line, note: d.target })) });
  if (graph.unresolvedImports.length) add({ severity: "minor", category: "Web", title: `${graph.unresolvedImports.length} imports the explorer couldn't resolve`, detail: "Not a file in the repo and not a package in a package.json.", evidence: graph.unresolvedImports.map((u) => ({ file: u.file, line: u.line, note: u.spec })) });

  // Big files.
  const big = files.filter((f) => (results.get(f.path)?.lines ?? 0) > 1500 && ["csharp", "typescript"].includes(results.get(f.path)?.kind));
  if (big.length) add({ severity: "minor", category: "Code size", title: `${big.length} source files are over 1,500 lines`, detail: "Large files are harder to change safely and to review; consider splitting by feature.", evidence: big.sort((a, b) => results.get(b.path).lines - results.get(a.path).lines).map((f) => ({ file: f.path, line: 1, note: `${results.get(f.path).lines} lines`, node: `file:${f.path}` })) });

  // Scan errors.
  if (scanErrors.length) add({ severity: "review", category: "Coverage", title: `${scanErrors.length} files failed to scan`, detail: "These files are listed but their contents are not in the map.", evidence: scanErrors.map((e) => ({ file: e.path, line: 1, note: e.error })) });

  // Cross-check against the project's own test table.
  const crossChecks = [];
  for (const f of files) {
    const r = results.get(f.path);
    for (const pc of r?.permissionCounts ?? []) {
      const scanned = new Map();
      for (const e of graph.edges) if (e.kind === "guarded-by") scanned.set(e.to.slice(5), (scanned.get(e.to.slice(5)) ?? 0) + 1);
      const rows = pc.rows.map((row) => ({ permission: row.permission, expected: row.count, scanned: scanned.get(row.permission) ?? 0, line: row.line }));
      for (const [p, n] of scanned) if (!pc.rows.some((row) => row.permission === p)) rows.push({ permission: p, expected: null, scanned: n });
      const mismatches = rows.filter((x) => x.expected !== x.scanned);
      crossChecks.push({ name: `${f.path.split("/").pop()} · ${pc.name}`, file: f.path, line: pc.line, rows, agree: mismatches.length === 0 });
      if (mismatches.length) add({ severity: "review", category: "Coverage", title: `Route guards disagree with ${pc.name} in ${f.path.split("/").pop()}`, detail: "The test lists how many addresses each permission guards. Either the test table or the explorer is out of date.", evidence: mismatches.map((m) => ({ file: f.path, line: m.line ?? pc.line, note: `${m.permission}: test ${m.expected ?? "—"}, scanned ${m.scanned}` })) });
    }
  }

  const order = { important: 0, review: 1, minor: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { findings, coverage: computeCoverage({ graph, files, results, scanErrors, crossChecks }) };
}

function computeCoverage({ graph, files, results, scanErrors, crossChecks }) {
  const sum = (kind, key) => files.reduce((a, f) => a + (results.get(f.path)?.kind === kind ? results.get(f.path).raw?.[key] ?? 0 : 0), 0);
  const nodes = Object.values(graph.nodes);
  const endpoints = nodes.filter((n) => n.type === "endpoint");
  const byScanner = {};
  const notAnalyzed = [];
  for (const f of files) {
    const s = f.cls.scanner ?? "none";
    byScanner[s] = (byScanner[s] ?? 0) + 1;
    if (!f.cls.scanner) notAnalyzed.push({ path: f.path, reason: f.cls.reason });
  }
  const mapRaw = sum("csharp", "mapVerbs");
  const mapCode = sum("csharp", "mapVerbsInCode");
  // Distinct Map* lines understood (a helper's one Map line expands into one route per call of the helper).
  let mapCallsParsed = 0;
  let helperLines = 0;
  let helperRoutes = 0;
  let testMaps = 0;
  for (const f of files) {
    const r = results.get(f.path);
    if (r?.kind !== "csharp") continue;
    const lines = new Set(r.mapCalls.map((m) => m.helper?.line ?? m.line));
    if (f.cls.layer === "tests") {
      testMaps += lines.size;
      continue;
    }
    mapCallsParsed += lines.size;
    helperLines += new Set(r.mapCalls.filter((m) => m.helper).map((m) => m.helper.line)).size;
    helperRoutes += r.mapCalls.filter((m) => m.helper).length;
  }
  mapCallsParsed += testMaps;
  const guardsRaw = sum("csharp", "guards");
  const guardsCode = sum("csharp", "guardsInCode");
  // Distinct guard calls understood (one RequireAuthorization on a route group protects every route in it).
  const guardSites = new Set();
  for (const e of endpoints) for (const g of e.data.auth?.routeAuth ?? []) if (g.note?.startsWith(".") && (g.name || g.kind === "signed-in")) guardSites.add(`${g.file}:${g.line}`);
  const guardsAttached = guardSites.size;
  const httpRaw = sum("csharp", "httpAttributes");
  const controllerParsed = files.reduce((a, f) => a + new Set((results.get(f.path)?.controllerEndpoints ?? []).map((c) => `${c.line}:${c.verb}`)).size, 0);
  const guardsUnresolved = endpoints.reduce((a, e) => a + (e.data.auth?.routeAuth?.filter((p) => p.kind === "permission" && !p.name).length ?? 0), 0);
  const diRaw = sum("csharp", "di");
  const diParsed = files.reduce((a, f) => a + (results.get(f.path)?.di?.length ?? 0), 0);
  const createRaw = sum("migration", "createTable");
  const cs = graph.callStats;
  const tsRawApi = sum("typescript", "apiCalls");
  const tsRawFetch = sum("typescript", "fetchCalls") + sum("typescript", "clientCalls");
  // Distinct call sites understood, per file (a helper's one fetch line counts once however many callers it has),
  // so a call the parser missed shows up as a leftover with its file instead of being hidden by expansions.
  let tsParsed = 0;
  const callLeftovers = [];
  for (const f of files) {
    const r = results.get(f.path);
    if (r?.kind !== "typescript") continue;
    const sites = new Set(r.apiCalls.map((c) => c.site ?? c.helperLine ?? c.line)).size;
    const raw = (r.raw?.apiCalls ?? 0) + (r.raw?.fetchCalls ?? 0) + (r.raw?.clientCalls ?? 0);
    tsParsed += Math.min(sites, raw);
    if (raw > sites) callLeftovers.push({ file: f.path, line: 1, what: `${raw - sites} call site(s) found by text but not by the parser` });
  }
  const importsAll = files.reduce((a, f) => a + (results.get(f.path)?.imports?.length ?? 0), 0);
  const sqlLiterals = files.reduce((a, f) => a + (results.get(f.path)?.sql?.length ?? 0), 0);
  const counts = graph.schemaInfo.counts;

  const rows = [
    {
      area: "C# route mappings (MapGet/Post/Put/Delete/Patch)",
      raw: mapRaw,
      matched: mapCallsParsed,
      left: mapCode - mapCallsParsed,
      detail: `${mapRaw} raw matches = ${mapCode} in code + ${mapRaw - mapCode} in comments. ${mapCode - testMaps} in the API project, ${testMaps} in test projects (their own throwaway routes, not mapped). ${helperLines} Map lines sit in helper methods and expand into ${helperRoutes} routes, one per call. ${endpoints.length} addresses in all; ${endpoints.filter((e) => e.data.resolved).length} with a fully resolved path.`,
      leftovers: graph.endpointNotes,
    },
    {
      area: "Route guards (RequireAuthorization and configured guards)",
      raw: guardsRaw,
      matched: guardsAttached,
      left: guardsCode - guardsAttached - guardsUnresolved,
      detail: `${guardsRaw} raw matches = ${guardsCode} in code + ${guardsRaw - guardsCode} in comments. ${guardsAttached} guard calls understood (on a route or a route group)${guardsUnresolved ? `; ${guardsUnresolved} with a permission passed as a variable` : ""}. [Authorize] attributes are counted on the controller row.`,
    },
    {
      area: "Controller actions ([HttpGet] / [HttpPost] ... attributes)",
      raw: httpRaw,
      matched: controllerParsed,
      left: httpRaw - controllerParsed,
      detail: `${controllerParsed} controller actions with attribute routes read, with their [Authorize] / [AllowAnonymous] attributes. Controllers routed only by convention (MapControllerRoute) are not mapped to addresses.`,
    },
    {
      area: "Dependency injection registrations",
      raw: diRaw,
      matched: diParsed,
      left: diRaw - diParsed,
      detail: `${diParsed} registrations read; ${graph.diTypes.length} resolved to a type in the repo (the rest are framework types such as TimeProvider).`,
      leftovers: graph.notes,
    },
    {
      area: "Frontend HTTP call sites (fetch, axios, api clients and helpers)",
      raw: tsRawApi + tsRawFetch,
      matched: tsParsed,
      left: tsRawApi + tsRawFetch - tsParsed,
      detail: `Counted as distinct places in the code, test files included. Linking: ${cs.total} calls outside the API helper (a local helper's callers and a ternary's two paths count separately here): ${cs.verified} matched one route exactly (verified), ${cs.inferred} matched with dynamic segments (inferred), ${cs.unresolved} unresolved. Calls inside a file that defines an api*/http* helper are the helper itself.`,
      leftovers: callLeftovers,
    },
    {
      area: "TypeScript imports",
      raw: importsAll,
      matched: importsAll - graph.unresolvedImports.length,
      left: graph.unresolvedImports.length,
      detail: "Resolved to a file in the repo (with the @/ alias) or a package in web/package.json.",
      leftovers: graph.unresolvedImports.map((u) => ({ file: u.file, line: u.line, what: u.spec })),
    },
    {
      area: "Tables (CREATE TABLE)",
      raw: createRaw,
      matched: counts.createTable,
      left: createRaw - counts.createTable,
      detail: `${counts.createTable} created, ${graph.schemaInfo.dropped.length} dropped later (${graph.schemaInfo.dropped.map((d) => d.name).join(", ") || "none"}), ${nodes.filter((n) => n.type === "table").length} in the final schema.`,
    },
    {
      area: "ALTER TABLE actions",
      raw: counts.alterActions,
      matched: counts.alterModeled,
      left: counts.alterActions - counts.alterModeled,
      detail: "Columns added, dropped, renamed or retyped, constraints and row-level security, replayed in migration order.",
      leftovers: graph.schemaInfo.unmodeled.map((u) => ({ file: u.file, line: u.line, what: `${u.what}: ${u.text}` })),
    },
    {
      area: "SQL in C# (table names after FROM/JOIN/INTO/UPDATE)",
      raw: sqlLiterals,
      matched: graph.edges.filter((e) => ["reads", "writes", "reads-writes"].includes(e.kind)).length,
      left: graph.schemaInfo.sqlUnknown.length,
      detail: `${sqlLiterals} SQL strings read. Names that matched no table (CTEs, columns, function arguments) are listed, not linked.`,
      leftovers: graph.schemaInfo.sqlUnknown.slice(0, 200).map((u) => ({ file: u.file, line: u.line, what: u.name })),
    },
    {
      area: "Functions and triggers",
      raw: counts.functions + counts.triggers,
      matched: counts.triggers,
      left: counts.functions,
      detail: `${counts.triggers} triggers recorded with their table and function. ${counts.functions} function bodies (PL/pgSQL) are not analyzed; tables named in them are listed on the function only.`,
    },
  ];

  const status = { verified: 0, inferred: 0, unresolved: 0 };
  const byKind = {};
  for (const e of graph.edges) {
    status[e.status]++;
    const k = (byKind[e.kind] ??= { verified: 0, inferred: 0, unresolved: 0 });
    k[e.status]++;
  }

  return {
    files: { total: files.length, analyzed: files.length - notAnalyzed.length, byScanner, notAnalyzed, errors: scanErrors },
    rows,
    edges: { ...status, byKind },
    crossChecks,
    limits: [
      "C# is read as text by a C#-aware lexer (comments and every string form handled), not compiled. Type references are name matches with the namespace in scope, so they are marked inferred; overloads and extension methods are matched by name.",
      "Authorization: the explorer reads [Authorize] / [AllowAnonymous], RequireAuthorization, AllowAnonymous, route groups, AddPolicy, the fallback policy, the project's configured route guards, and configured permission checks inside handlers and the methods they call (four levels). Middleware, endpoint filters or gateways set up another way would be missed.",
      "Runtime behaviour is not observed: configuration values, which branch a handler takes, what the database actually holds.",
      "SQL: table names are read from string literals. SQL assembled at run time and PL/pgSQL bodies (functions, DO blocks) are listed, not interpreted.",
      "Frontend calls: fetch, axios, api*/http* helpers and configured clients. Paths are worked out inside one file (constants, template strings, local helper functions); a path passed in from another file stays unresolved, and a path after an unknown base address is matched as inferred.",
      "Screens reach an API through imports: that means the code is loaded with the screen, not that every call happens on it.",
      "The business workflow steps come from the document named in .architecture-explorer.json; which code belongs to each step is a keyword list kept there, so those links are inferred.",
      "Not modeled: EF Core migrations written in C# (tables come from DbSet properties instead), JavaScript backends (Express, Next.js API routes), GraphQL and gRPC.",
      "Not read at all: PDFs, images and other binary files (listed under Other files).",
    ],
  };
}

// Extracts facts from one C# file: namespace, usings, types, enums, methods, minimal-API route mappings and their
// guards, route groups, DI registrations, SQL table use, URLs and permission references. Every fact keeps its line.
import { lexCSharp } from "./csharp-lexer.mjs";
import { lineIndex, matchBracket, skipSpace, skipSpaceBack, splitTopLevel } from "./text.mjs";

const KEYWORDS = new Set([
  "if", "for", "foreach", "while", "switch", "catch", "using", "lock", "fixed", "return", "new", "nameof", "typeof",
  "sizeof", "default", "when", "checked", "unchecked", "base", "this", "await", "throw", "else", "case", "in", "is",
  "as", "yield", "async", "static", "and", "or", "not", "var", "out", "ref", "params", "stackalloc", "do", "try",
  "finally", "get", "set", "init", "add", "remove", "where", "select", "from", "let", "orderby", "group", "join",
]);
const TYPE_WORDS = new Set(["class", "record", "struct", "interface", "enum", "delegate"]);
const MAP_VERBS = { MapGet: ["GET"], MapPost: ["POST"], MapPut: ["PUT"], MapDelete: ["DELETE"], MapPatch: ["PATCH"], MapMethods: null };
const SQL_HINT = /\b(select|insert|update|delete|with)\b/i;
const SQL_HINT2 = /\b(from|into|set|join)\b/i;

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** "Perms.Require" -> a regex for the call `Perms . Require (`. */
const callRe = (name) => new RegExp(`(?<![\\w.])${name.split(".").map(reEscape).join("\\s*\\.\\s*")}\\s*(?:<[^<>()]*>)?\\s*\\(`, "g");

/**
 * opts (all optional, from the project's config): permissionEnum, roleEnum, routeGuards, requireChecks, allowsChecks.
 * Without them the scanner still reads every ASP.NET Core convention: [Authorize], RequireAuthorization, AllowAnonymous,
 * policies, roles and the fallback policy.
 */
export function scanCSharp(text, path, opts = {}) {
  const { masked, strings, comments } = lexCSharp(text);
  const lineOf = lineIndex(text);
  const rawLines = text.split("\n");
  const stringAt = new Map(strings.map((s) => [s.start, s]));
  const PERM = opts.permissionEnum ?? null;
  const ROLE = opts.roleEnum ?? null;
  const guardNames = ["RequireAuthorization", ...(opts.routeGuards ?? [])];
  const guardRaw = new RegExp(`\\.\\s*(${guardNames.map(reEscape).join("|")})\\s*\\(`, "g");
  const sig = {
    perm: PERM ? new RegExp(`\\b${reEscape(PERM)}\\.([A-Z]\\w*)`) : null,
    require: (opts.requireChecks ?? []).map(callRe),
    allows: (opts.allowsChecks ?? []).map(callRe),
    stringAt,
  };
  const result = {
    kind: "csharp",
    namespace: null,
    usings: [],
    types: [],
    enums: [],
    methods: [],
    mapCalls: [],
    groups: [],
    extCalls: [],
    rootVars: [],
    di: [],
    sql: [],
    sqlUnknown: [],
    urls: [],
    permissionRefs: [],
    constPerms: {},
    typeTokens: {},
    routeLiterals: [],
    configSections: [],
    fallbackPolicy: null,
    tests: { classes: 0, methods: 0 },
    summary: null,
    lines: rawLines.length,
    raw: {
      mapVerbs: count(text, /\.\s*Map(Get|Post|Put|Delete|Patch|Methods)\s*\(/g),
      mapVerbsInCode: count(masked, /\.\s*Map(Get|Post|Put|Delete|Patch|Methods)\s*\(/g),
      guards: count(text, guardRaw),
      guardsInCode: count(masked, guardRaw),
      authorizeAttributes: count(masked, /\[\s*(?:[\w.]+\s*,\s*)*(Authorize|AllowAnonymous)\b/g),
      httpAttributes: count(masked, /\[\s*(?:[\w.]+\s*,\s*)*Http(Get|Post|Put|Delete|Patch)\b/g),
      di: count(masked, /\.\s*(TryAdd|Add)(Singleton|Scoped|Transient|HttpClient)\b/g),
    },
  };

  // Namespace and usings.
  const ns = /\bnamespace\s+([\w.]+)\s*[;{]/.exec(masked);
  if (ns) result.namespace = ns[1];
  for (const m of masked.matchAll(/^[ \t]*(global\s+)?using\s+(static\s+)?(?:(\w+)\s*=\s*)?([A-Za-z_][\w.]*)\s*;/gm)) {
    result.usings.push({ ns: m[4], alias: m[3] ?? null, static: !!m[2], line: lineOf(m.index) });
  }

  // Types (with their body range, base list and doc summary).
  for (const m of masked.matchAll(/\b(class|interface|enum|struct|record)\s+(?:(class|struct)\s+)?([A-Za-z_]\w*)/g)) {
    const before = masked.slice(Math.max(0, m.index - 12), m.index);
    if (/\.\s*$/.test(before)) continue;
    const name = m[3];
    if (KEYWORDS.has(name)) continue;
    let k = skipSpace(masked, m.index + m[0].length);
    if (masked[k] === "<") k = skipSpace(masked, matchAngle(masked, k) + 1);
    let primary = null;
    if (masked[k] === "(") {
      const close = matchBracket(masked, k);
      if (close < 0) continue;
      primary = { start: k, end: close };
      k = skipSpace(masked, close + 1);
    }
    const bases = [];
    if (masked[k] === ":") {
      let e = k + 1;
      while (e < masked.length && masked[e] !== "{" && masked[e] !== ";" && !/^\bwhere\b/.test(masked.slice(e, e + 6))) {
        if (masked[e] === "(") e = matchBracket(masked, e);
        e++;
      }
      for (const part of splitTopLevel(masked, k + 1, e, { generics: true })) {
        const b = masked.slice(part.start, part.end).trim().replace(/\(.*$/s, "");
        const baseName = b.replace(/<.*$/s, "").split(".").pop();
        if (baseName) bases.push(baseName);
      }
      k = e;
    }
    while (k < masked.length && masked[k] !== "{" && masked[k] !== ";") k++;
    const bodyStart = masked[k] === "{" ? k : -1;
    const bodyEnd = bodyStart >= 0 ? matchBracket(masked, bodyStart) : -1;
    const line = lineOf(m.index);
    const kind = m[2] ? `${m[1]} ${m[2]}` : m[1];
    const declLine = rawLines[line - 1] ?? "";
    const type = {
      name,
      kind,
      line,
      start: m.index,
      bodyStart,
      bodyEnd,
      bases,
      partial: /\bpartial\b/.test(declLine),
      visibility: (/\b(public|internal|private|protected|file)\b/.exec(declLine) ?? [])[1] ?? "internal",
      summary: docAbove(rawLines, line),
      primaryParams: primary ? parseParams(masked, primary.start + 1, primary.end) : [],
      attributes: readAttributes(masked, stringAt, m.index, lineOf),
    };
    result.types.push(type);
    if (m[1] === "enum" && bodyStart >= 0) result.enums.push(readEnum(masked, rawLines, lineOf, type));
  }
  result.summary = (result.types.find((t) => t.visibility === "public" && t.summary) ?? result.types.find((t) => t.summary))?.summary ?? null;

  // Methods (including local functions and constructors).
  for (const m of masked.matchAll(/([A-Za-z_]\w*)\s*(<[^<>(){};=]*(?:<[^<>(){};=]*>[^<>(){};=]*)*>)?\s*\(/g)) {
    const name = m[1];
    if (KEYWORDS.has(name)) continue;
    const prev = skipSpaceBack(masked, m.index - 1);
    if (prev < 0 || !/[\w>\])?]/.test(masked[prev])) continue;
    const prevWord = /(\w+)$/.exec(masked.slice(Math.max(0, prev - 30), prev + 1));
    if (prevWord && (KEYWORDS.has(prevWord[1]) && !["static", "async"].includes(prevWord[1]))) continue;
    if (prevWord && TYPE_WORDS.has(prevWord[1])) continue;
    const open = masked.indexOf("(", m.index + name.length);
    const close = matchBracket(masked, open);
    if (close < 0) continue;
    let k = skipSpace(masked, close + 1);
    if (masked.startsWith("where", k) || masked[k] === ":") {
      while (k < masked.length && masked[k] !== "{" && !masked.startsWith("=>", k) && masked[k] !== ";") {
        if (masked[k] === "(") k = matchBracket(masked, k);
        k++;
      }
    }
    let bodyStart;
    let bodyEnd;
    let expression = false;
    if (masked[k] === "{") {
      bodyStart = k;
      bodyEnd = matchBracket(masked, k);
    } else if (masked.startsWith("=>", k)) {
      expression = true;
      bodyStart = k + 2;
      bodyEnd = statementEnd(masked, bodyStart);
    } else continue;
    if (bodyEnd < 0) continue;
    const params = parseParams(masked, open + 1, close);
    result.methods.push({
      name,
      line: lineOf(m.index),
      start: m.index,
      bodyStart,
      bodyEnd,
      expression,
      params,
      thisParam: params.find((p) => p.this) ?? null,
      summary: docAbove(rawLines, lineOf(m.index)),
      attributes: readAttributes(masked, stringAt, m.index, lineOf),
      ...bodySignals(masked, bodyStart, bodyEnd, lineOf, sig),
    });
  }
  result.methods.sort((a, b) => a.start - b.start);
  for (const mm of result.methods) {
    let owner = null;
    for (const t of result.types) {
      if (t.bodyStart >= 0 && t.bodyStart <= mm.start && mm.start <= t.bodyEnd && (!owner || t.bodyStart >= owner.bodyStart)) owner = t;
    }
    mm.owner = owner?.name ?? null;
  }
  const enclosingMethod = (offset) => {
    let best = null;
    for (const mm of result.methods) {
      if (mm.start <= offset && offset <= mm.bodyEnd && (!best || mm.start >= best.start)) best = mm;
    }
    return best;
  };
  const enclosingType = (offset) => {
    let best = null;
    for (const t of result.types) {
      if (t.bodyStart >= 0 && t.bodyStart <= offset && offset <= t.bodyEnd && (!best || t.bodyStart >= best.bodyStart)) best = t;
    }
    return best;
  };

  // Const permission aliases: const Permission View = Permission.ViewOrders;
  if (PERM) for (const m of masked.matchAll(new RegExp(`\\bconst\\s+${reEscape(PERM)}\\s+(\\w+)\\s*=\\s*${reEscape(PERM)}\\.(\\w+)\\s*;`, "g"))) result.constPerms[m[1]] = m[2];
  const constStrings = {};
  for (const m of masked.matchAll(/\bconst\s+string\s+(\w+)\s*=\s*/g)) {
    const lit = stringAt.get(skipSpace(masked, m.index + m[0].length));
    if (lit) constStrings[m[1]] = lit.value;
  }

  // Route groups: var x = parent.MapGroup("/prefix")
  for (const m of masked.matchAll(/\b(?:var|RouteGroupBuilder)\s+(\w+)\s*=\s*(\w+)\s*\.\s*MapGroup\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(masked, open);
    const lit = literalAt(masked, stringAt, constStrings, open + 1);
    result.groups.push({
      var: m[1],
      parent: m[2],
      prefix: lit,
      line: lineOf(m.index),
      method: enclosingMethod(m.index)?.name ?? null,
      chain: readChain(masked, close + 1, lineOf, stringAt),
    });
  }
  // Root builders: var app = builder.Build();
  for (const m of masked.matchAll(/\bvar\s+(\w+)\s*=\s*\w+\s*\.\s*Build\s*\(\s*\)/g)) {
    result.rootVars.push({ var: m[1], method: enclosingMethod(m.index)?.name ?? null, line: lineOf(m.index) });
  }

  // Route mappings: receiver.MapGet("/pattern", Handler).Chain(...)
  for (const m of masked.matchAll(/\b([A-Za-z_]\w*)\s*\.\s*(Map(?:Get|Post|Put|Delete|Patch|Methods))\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(masked, open);
    const line = lineOf(m.index);
    const args = close > 0 ? splitTopLevel(masked, open + 1, close) : [];
    const pattern = args[0] ? literalAt(masked, stringAt, constStrings, args[0].start) : null;
    let verbs = MAP_VERBS[m[2]];
    let handlerArg = args[1];
    if (!verbs && args.length >= 3) {
      verbs = [...text.slice(args[1].start, args[1].end).matchAll(/"([A-Z]+)"/g)].map((v) => v[1]);
      handlerArg = args[2];
    }
    const method = enclosingMethod(m.index);
    const base = {
      receiver: m[1],
      verbs: verbs ?? [],
      pattern,
      patternText: args[0] ? text.slice(args[0].start, args[0].end).trim() : "",
      line,
      method: method?.name ?? null,
      handler: handlerArg ? readHandler(masked, text, handlerArg, lineOf, sig) : null,
      chain: close > 0 ? readChain(masked, close + 1, lineOf, stringAt) : [],
    };
    // A helper that maps on a RouteGroupBuilder parameter (Job(api, "complete", ...)): expand each call of it in this
    // file into its own route, filling `{action}` holes with the literal the call passes.
    const recvParam = method?.params.find((p) => p.name === m[1] && !p.this);
    if (recvParam && method) {
      const recvIndex = method.params.indexOf(recvParam);
      const template = args[0] ? stringAt.get(skipSpace(masked, args[0].start)) : null;
      const sites = [...masked.matchAll(new RegExp(`(?<![\\w.])${method.name}\\s*\\(`, "g"))].filter((s) => s.index !== method.start);
      for (const s of sites) {
        const sOpen = s.index + s[0].length - 1;
        const sClose = matchBracket(masked, sOpen);
        if (sClose < 0) continue;
        const sArgs = splitTopLevel(masked, sOpen + 1, sClose);
        const recv = sArgs[recvIndex] ? masked.slice(sArgs[recvIndex].start, sArgs[recvIndex].end).trim() : null;
        if (!recv || !/^\w+$/.test(recv)) continue;
        let sitePattern = pattern;
        if (template && template.interpolated) {
          sitePattern = template.value.replace(/\u0001([^\u0002]*)\u0002/g, (_, expr) => {
            const pi = method.params.findIndex((p) => p.name === expr.trim());
            const lit = pi >= 0 && sArgs[pi] ? stringAt.get(skipSpace(masked, sArgs[pi].start)) : null;
            return lit && !lit.interpolated ? lit.value : "{?}";
          });
        }
        const siteSignals = bodySignals(masked, sOpen + 1, sClose, lineOf, sig);
        const h = base.handler;
        const merged = h && h.kind === "lambda"
          ? {
              ...h,
              signals: {
                resolvesUser: h.signals.resolvesUser || siteSignals.signals.resolvesUser,
                requires: [...h.signals.requires, ...siteSignals.signals.requires],
                allows: [...h.signals.allows, ...siteSignals.signals.allows],
              },
              calls: [...new Set([...h.calls, ...siteSignals.calls])],
              bodyTypes: [...new Set([...h.bodyTypes, ...siteSignals.bodyTypes])],
            }
          : h;
        result.mapCalls.push({
          ...base,
          receiver: recv,
          pattern: sitePattern,
          line: lineOf(s.index),
          method: enclosingMethod(s.index)?.name ?? null,
          helper: { name: method.name, line },
          handler: merged,
        });
      }
      if (sites.length) continue;
    }
    if (pattern === null && args[0]) {
      const lit = stringAt.get(skipSpace(masked, args[0].start));
      if (lit?.interpolated) base.pattern = lit.value.replace(/\u0001[^\u0002]*\u0002/g, "{?}");
    }
    result.mapCalls.push(base);
  }
  // app.MapControllers().RequireAuthorization(...) applies to every controller action.
  for (const m of masked.matchAll(/\.\s*MapControllers\s*\(\s*\)/g)) {
    (result.mapControllers ??= []).push({ line: lineOf(m.index), chain: readChain(masked, m.index + m[0].length, lineOf, stringAt) });
  }
  // Calls of other Map* extension methods (api.MapAuth()), used to follow route prefixes across files.
  for (const m of masked.matchAll(/\b([A-Za-z_]\w*)\s*\.\s*(Map[A-Z]\w*)\s*\(/g)) {
    if (MAP_VERBS[m[2]] !== undefined || m[2] === "MapMethods" || m[2] === "MapGroup" || m[2] === "MapControllers") continue;
    result.extCalls.push({ receiver: m[1], name: m[2], line: lineOf(m.index), method: enclosingMethod(m.index)?.name ?? null });
  }

  // Dependency injection registrations.
  for (const m of masked.matchAll(/\.\s*(TryAdd|Add)(Singleton|Scoped|Transient|HttpClient)\s*(<([^()]*?)>)?\s*\(/g)) {
    const typeArgs = m[4] ? splitTopLevel(m[4], 0, m[4].length, { generics: true }).map((p) => m[4].slice(p.start, p.end).trim().split(".").pop()) : [];
    const open = m.index + m[0].length - 1;
    const close = matchBracket(masked, open);
    let factoryType = null;
    if (typeArgs.length === 0 && close > 0) {
      const body = masked.slice(open, close);
      const f = /=>\s*(?:new\s+([A-Z]\w*)|([A-Z]\w*)\s*\.\s*Create\w*\s*\()/.exec(body);
      factoryType = f ? f[1] ?? f[2] : null;
    }
    result.di.push({
      lifetime: m[2],
      tryAdd: m[1] === "TryAdd",
      service: typeArgs[0] ?? factoryType,
      impl: typeArgs[1] ?? typeArgs[0] ?? factoryType,
      fromFactory: typeArgs.length === 0,
      line: lineOf(m.index),
    });
  }

  // Sign-in by default: options.FallbackPolicy / SetFallbackPolicy(... RequireAuthenticatedUser ...)
  const fb = /SetFallbackPolicy\s*\(|FallbackPolicy\s*=/.exec(masked);
  if (fb) {
    const end = statementEnd(masked, fb.index);
    result.fallbackPolicy = { line: lineOf(fb.index), requiresSignIn: /RequireAuthenticatedUser/.test(masked.slice(fb.index, end)) };
  }

  // String literals: SQL, URLs, API routes (tests), configuration sections.
  for (const s of strings) {
    const v = s.value;
    if (SQL_HINT.test(v) && SQL_HINT2.test(v) && v.length > 12) {
      const { tables, unknown } = sqlTables(v);
      if (tables.length || unknown.length) {
        const t = enclosingType(s.start);
        const mm = enclosingMethod(s.start);
        result.sql.push({
          line: lineOf(s.start),
          type: t?.name ?? null,
          method: mm?.name ?? null,
          tables,
          dynamic: s.interpolated && /\b(from|join|into|update)\s*\u0001/i.test(v),
        });
        for (const u of unknown) result.sqlUnknown.push({ name: u, line: lineOf(s.start) });
      }
    }
    if (/^https?:\/\/[^\s"]+$/i.test(v)) result.urls.push({ url: v, line: lineOf(s.start) });
    if (/^\/?api\//.test(v)) {
      const route = v.replace(/\u0001[^\u0002]*\u0002/g, "{*}");
      result.routeLiterals.push({ value: route.startsWith("/") ? route : `/${route}`, line: lineOf(s.start), interpolated: s.interpolated });
    }
  }
  for (const m of masked.matchAll(/\b(?:const\s+string\s+Section\s*=|GetSection\s*\()\s*/g)) {
    const lit = stringAt.get(skipSpace(masked, m.index + m[0].length));
    if (lit) result.configSections.push({ name: lit.value, line: lineOf(m.index) });
  }

  if (PERM) {
    const P = reEscape(PERM);
    // Permission catalogue entries: new(Permission.X, <module>, "Name", "Description")
    for (const m of masked.matchAll(new RegExp(`\\bnew\\s*\\w*\\s*\\(\\s*${P}\\.(\\w+)\\s*,`, "g"))) {
      const open = masked.indexOf("(", m.index);
      const close = matchBracket(masked, open);
      if (close < 0) continue;
      const args = splitTopLevel(masked, open + 1, close);
      const lits = args.map((a) => stringAt.get(skipSpace(masked, a.start))).filter(Boolean);
      if (!lits.length) continue;
      // The second argument names the permission's group when it is an identifier (Module.Jobs), not a string.
      const second = args[1] && !stringAt.get(skipSpace(masked, args[1].start)) ? masked.slice(args[1].start, args[1].end).trim() : null;
      const module = second ? (/(\w+)$/.exec(second) ?? [])[1] ?? null : null;
      (result.permissionCatalog ??= []).push({ permission: m[1], module, name: lits[0]?.value ?? null, description: lits[1]?.value ?? null, line: lineOf(m.index) });
    }
    // Default roles per permission: Dictionary<Permission, Role[]> = ... { [Permission.X] = [...], ... }
    if (ROLE && new RegExp(`Dictionary\\s*<\\s*${P}\\s*,\\s*${reEscape(ROLE)}\\s*\\[\\s*\\]\\s*>`).test(masked)) result.permissionDefaults = readPermissionDefaults(masked, lineOf, PERM, ROLE);
    // Expected counts per permission (a test that lists how many routes each permission guards).
    for (const d of masked.matchAll(new RegExp(`Dictionary\\s*<\\s*${P}\\s*,\\s*int\\s*>\\s+(\\w+)\\s*=\\s*new\\s*(?:Dictionary\\s*<[^>]*>)?\\s*\\(\\s*\\)\\s*\\{`, "g"))) {
      const open = d.index + d[0].length - 1;
      const body = masked.slice(open, matchBracket(masked, open));
      const rows = [...body.matchAll(new RegExp(`\\[\\s*${P}\\.(\\w+)\\s*\\]\\s*=\\s*(\\d+)`, "g"))].map((m) => ({ permission: m[1], count: Number(m[2]), line: lineOf(open + m.index) }));
      (result.permissionCounts ??= []).push({ name: d[1], line: lineOf(d.index), rows });
    }
    for (const m of masked.matchAll(new RegExp(`\\b${P}\\.([A-Z]\\w*)`, "g"))) result.permissionRefs.push({ name: m[1], line: lineOf(m.index) });
  }

  // Authorization policies: options.AddPolicy("Name", p => p.RequireRole("Admin").RequireClaim("x"))
  for (const m of masked.matchAll(/\bAddPolicy\s*\(/g)) {
    // CORS, rate limiting and output caching also have AddPolicy: only count the ones inside AddAuthorization.
    const before = masked.slice(Math.max(0, m.index - 3000), m.index);
    const last = (re) => {
      let at = -1;
      for (const x of before.matchAll(re)) at = x.index;
      return at;
    };
    const auth = last(/\bAddAuthorization(Builder|Core)?\b/g);
    if (auth < 0 || auth < Math.max(last(/\bAddRateLimiter\b/g), last(/\bAddCors\b/g), last(/\bAddOutputCache\b/g), last(/\bAddRequestTimeouts\b/g))) continue;
    const open = m.index + m[0].length - 1;
    const close = matchBracket(masked, open);
    const name = literalAt(masked, stringAt, constStrings, open + 1);
    if (!name || close < 0) continue;
    const inside = masked.slice(open, close);
    const roles = [];
    for (const r of inside.matchAll(/RequireRole\s*\(/g)) {
      const ro = open + r.index + r[0].length - 1;
      const rc = matchBracket(masked, ro);
      for (const a of splitTopLevel(masked, ro + 1, rc)) {
        const lit = stringAt.get(skipSpace(masked, a.start));
        if (lit) roles.push(...lit.value.split(",").map((x) => x.trim()).filter(Boolean));
      }
    }
    const claims = [...inside.matchAll(/RequireClaim\s*\(/g)].map((c) => stringAt.get(skipSpace(masked, open + c.index + c[0].length))?.value).filter(Boolean);
    (result.policies ??= []).push({ name, line: lineOf(m.index), roles, claims, signedIn: /RequireAuthenticatedUser/.test(inside) });
  }

  // MVC / Web API controllers with attribute routing: [Route("api/[controller]")] + [HttpGet("{id}")].
  for (const t of result.types) {
    if (!/class/.test(t.kind) || t.bodyStart < 0) continue;
    const classAttrs = t.attributes ?? [];
    const isController = /Controller$/.test(t.name) || classAttrs.some((a) => a.name === "ApiController") || t.bases.some((b) => /Controller(Base)?$/.test(b));
    if (!isController) continue;
    const classRoutes = classAttrs.filter((a) => a.name === "Route").map((a) => a.strings[0] ?? "");
    const ctor = result.methods.find((mm) => mm.name === t.name && mm.owner === t.name);
    const injected = [...(t.primaryParams ?? []), ...(ctor?.params ?? [])];
    for (const mm of result.methods.filter((x) => x.owner === t.name && x.name !== t.name)) {
      const http = (mm.attributes ?? []).filter((a) => /^Http(Get|Post|Put|Delete|Patch)$/.test(a.name));
      const methodRoute = (mm.attributes ?? []).find((a) => a.name === "Route")?.strings[0] ?? null;
      if (!http.length) continue;
      for (const h of http) {
        const verb = h.name.slice(4).toUpperCase();
        const tmpl = h.strings[0] ?? methodRoute ?? "";
        const bases = tmpl.startsWith("/") || tmpl.startsWith("~/") ? [""] : classRoutes.length ? classRoutes : [""];
        for (const base of bases) {
          const full = `/${[base, tmpl.replace(/^~?\//, "")].filter(Boolean).join("/")}`
            .replace(/\[controller\]/gi, t.name.replace(/Controller$/, ""))
            .replace(/\[action\]/gi, mm.name.replace(/Async$/, ""))
            .replace(/\/{2,}/g, "/");
          (result.controllerEndpoints ??= []).push({
            verb,
            route: full.length > 1 ? full.replace(/\/$/, "") : full,
            line: lineOf(mm.start),
            className: t.name,
            classLine: t.line,
            method: mm.name,
            auth: authFromAttributes([...classAttrs, ...(mm.attributes ?? [])]),
            injected,
          });
        }
      }
    }
  }

  // EF Core: DbSet<Order> Orders { get; set; } and modelBuilder.Entity<Order>().ToTable("orders")
  for (const m of masked.matchAll(/\bDbSet\s*<\s*([A-Z]\w*)\s*>\s+([A-Z]\w*)/g)) {
    (result.dbSets ??= []).push({ entity: m[1], name: m[2], line: lineOf(m.index), context: enclosingType(m.index)?.name ?? null });
  }
  for (const m of masked.matchAll(/\bEntity\s*<\s*([A-Z]\w*)\s*>\s*\(\s*\)/g)) {
    const end = statementEnd(masked, m.index);
    const tt = /\bToTable\s*\(\s*/.exec(masked.slice(m.index, end));
    const lit = tt ? stringAt.get(skipSpace(masked, m.index + tt.index + tt[0].length)) : null;
    if (lit) (result.efTables ??= []).push({ entity: m[1], table: lit.value, line: lineOf(m.index) });
  }

  // Tests: MSTest, xUnit, NUnit.
  result.tests.classes = count(masked, /\[\s*(TestClass|TestFixture)\b/g);
  result.tests.methods = count(masked, /\[\s*(DataTestMethod|TestMethod|Fact|Theory|Test|TestCase)\b/g);

  // Never ship offsets to the browser; keep only what the graph needs.
  for (const t of result.types) {
    delete t.start;
  }
  result.commentCount = comments.length;
  return result;
}

function count(s, re) {
  let n = 0;
  for (const _ of s.matchAll(re)) n++;
  return n;
}

function matchAngle(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "<") depth++;
    else if (s[i] === ">") {
      depth--;
      if (depth === 0) return i;
    } else if (s[i] === "{" || s[i] === ";") return i - 1;
  }
  return s.length - 1;
}

/** End of the statement that starts at `from`: the first `;` at bracket depth 0. */
function statementEnd(masked, from) {
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth < 0) return i;
    } else if (c === ";" && depth === 0) return i;
  }
  return masked.length;
}

/** The string literal (or const string) that an argument starting at `from` consists of, else null. */
function literalAt(masked, stringAt, constStrings, from) {
  const k = skipSpace(masked, from);
  const lit = stringAt.get(k);
  if (lit && !lit.interpolated) return lit.value;
  const id = /^([A-Za-z_]\w*)\s*[,)]/.exec(masked.slice(k, k + 80));
  if (id && constStrings[id[1]] !== undefined) return constStrings[id[1]];
  return null;
}

/** Parses a parameter list into [{type, name, this}]. */
function parseParams(masked, start, end) {
  const params = [];
  for (const part of splitTopLevel(masked, start, end, { generics: true })) {
    let p = masked.slice(part.start, part.end).replace(/\[[^\]]*\]/g, " ").replace(/=.*$/s, "").trim();
    if (!p) continue;
    const isThis = /^this\s/.test(p);
    p = p.replace(/^(this|ref|out|in|params|scoped)\s+/, "");
    const m = /^(.*?)\s*\b([A-Za-z_]\w*)$/s.exec(p);
    if (!m) continue;
    const type = m[1].replace(/\s+/g, "").trim();
    params.push({ type: type || null, name: m[2], this: isThis, baseType: baseTypeName(type) });
  }
  return params;
}

function baseTypeName(type) {
  if (!type) return null;
  const t = type.replace(/\?$/, "").replace(/<.*$/, "").replace(/\[\]$/, "");
  return t.split(".").pop() || null;
}

/**
 * What a method body does that matters for security and wiring. `sig` holds the project's configured checks
 * (requireChecks / allowsChecks, the permission enum); IsInRole("X") and AuthorizeAsync(user, "Policy") are built in.
 */
function bodySignals(masked, start, end, lineOf, sig) {
  const body = masked.slice(start, end);
  const requires = [];
  const allows = [];
  const read = (re, list) => {
    re.lastIndex = 0;
    for (const m of body.matchAll(re)) {
      const open = start + m.index + m[0].length - 1;
      const close = matchBracket(masked, open);
      if (close < 0 || close > end) continue;
      const argText = masked.slice(open + 1, close).replace(/\s+/g, " ").trim();
      const perm = sig.perm ? sig.perm.exec(argText) : null;
      let literal = null;
      for (const a of splitTopLevel(masked, open + 1, close)) {
        const lit = sig.stringAt.get(skipSpace(masked, a.start));
        if (lit) {
          literal = lit.value;
          break;
        }
      }
      list.push({ permission: perm ? perm[1] : literal, argText: argText.slice(0, 80), line: lineOf(start + m.index) });
    }
  };
  for (const re of sig.require) read(re, requires);
  for (const re of sig.allows) read(re, allows);
  // Built in: User.IsInRole("Admin") and authorizationService.AuthorizeAsync(User, resource?, "PolicyName").
  for (const m of body.matchAll(/\.\s*IsInRole\s*\(/g)) {
    const lit = sig.stringAt.get(skipSpace(masked, start + m.index + m[0].length));
    allows.push({ role: lit?.value ?? null, permission: null, argText: lit ? `"${lit.value}"` : "?", line: lineOf(start + m.index), builtIn: "IsInRole" });
  }
  for (const m of body.matchAll(/\bAuthorizeAsync\s*\(/g)) {
    const open = start + m.index + m[0].length - 1;
    const close = matchBracket(masked, open);
    let policy = null;
    if (close > 0) for (const a of splitTopLevel(masked, open + 1, close)) policy = sig.stringAt.get(skipSpace(masked, a.start))?.value ?? policy;
    allows.push({ policy, permission: null, argText: policy ? `"${policy}"` : "(requirement object)", line: lineOf(start + m.index), builtIn: "AuthorizeAsync" });
  }
  // Calls: "Name" (same class or a local function), "Type.Name" (static), "@var.Name" (on a variable or parameter).
  const calls = new Set();
  for (const m of body.matchAll(/(?<!\bnew\s+)(?:\b([A-Za-z_]\w*)\s*\.\s*)?\b([A-Za-z_]\w*)\s*(?:<[^<>()]*>)?\s*\(/g)) {
    if (KEYWORDS.has(m[2])) continue;
    const before = body.slice(Math.max(0, m.index - 2), m.index);
    if (!m[1] && /\.\s*$/.test(before)) calls.add(`.${m[2]}`);
    else if (!m[1]) calls.add(m[2]);
    else if (/^[A-Z]/.test(m[1])) calls.add(`${m[1]}.${m[2]}`);
    else calls.add(`@${m[1]}.${m[2]}`);
  }
  const bodyTypes = new Set();
  for (const m of body.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)) bodyTypes.add(m[1]);
  return {
    signals: {
      // The handler looks up the signed-in user itself (a common pattern: refuse with 401 when nobody is signed in).
      resolvesUser: /\bUser\s*\.\s*Identity\b|\.\s*Resolve\s*\(\s*\w+\s*\)|SignInRequired\s*\(|GetUserId\s*\(|\bClaimsPrincipal\b/.test(body),
      requires,
      allows,
    },
    calls: [...calls],
    bodyTypes: [...bodyTypes],
  };
}

/** Reads `.Name(args)` calls chained after offset `from`, with the string literals in their arguments. */
function readChain(masked, from, lineOf, stringAt) {
  const chain = [];
  let k = from;
  for (;;) {
    k = skipSpace(masked, k);
    if (masked[k] !== ".") break;
    const m = /^\.\s*([A-Za-z_]\w*)\s*(<[^<>()]*>)?\s*\(/.exec(masked.slice(k, k + 200));
    if (!m) break;
    const open = k + m[0].length - 1;
    const close = matchBracket(masked, open);
    if (close < 0) break;
    const strings = [];
    for (const a of splitTopLevel(masked, open + 1, close)) {
      const lit = stringAt?.get(skipSpace(masked, a.start));
      if (lit && !lit.interpolated) strings.push(lit.value);
    }
    chain.push({ name: m[1], args: masked.slice(open + 1, close).replace(/\s+/g, " ").trim(), strings, line: lineOf(k) });
    k = close + 1;
  }
  return chain;
}

/** A Map* handler argument: a method group (Name or Type.Name), a lambda, or another expression. */
function readHandler(masked, text, arg, lineOf, sig) {
  const src = masked.slice(arg.start, arg.end).trim();
  const line = lineOf(arg.start + (masked.slice(arg.start, arg.end).length - masked.slice(arg.start, arg.end).trimStart().length));
  if (/^[A-Za-z_][\w.]*$/.test(src)) {
    const parts = src.split(".");
    return { kind: "method", name: parts.pop(), owner: parts.pop() ?? null, line };
  }
  const arrow = src.indexOf("=>");
  if (arrow >= 0) {
    const head = src.slice(0, arrow);
    const pOpen = head.indexOf("(");
    const pClose = head.lastIndexOf(")");
    const absStart = arg.start + masked.slice(arg.start, arg.end).indexOf(src);
    const params = pOpen >= 0 && pClose > pOpen ? parseParams(masked, absStart + pOpen + 1, absStart + pClose) : [];
    return {
      kind: "lambda",
      line,
      params,
      attributes: readLambdaAttributes(masked, sig.stringAt, absStart, absStart + pOpen, lineOf),
      text: text.slice(arg.start, Math.min(arg.end, arg.start + 160)).trim(),
      ...bodySignals(masked, absStart + arrow + 2, arg.end, lineOf, sig),
    };
  }
  return { kind: "expression", line, text: src.slice(0, 120) };
}

/** Attributes written on a lambda: ([Authorize] (int id) => ...) */
function readLambdaAttributes(masked, stringAt, from, to, lineOf) {
  if (to <= from) return [];
  const out = [];
  const seg = masked.slice(from, to);
  for (const m of seg.matchAll(/\[/g)) {
    const open = from + m.index;
    const close = matchBracket(masked, open);
    if (close > 0 && close <= to) out.push(...parseAttributeBlock(masked, stringAt, open, close, lineOf));
  }
  return out;
}

/**
 * The attributes written just before a declaration at `offset` (a class or method name), skipping modifiers and the
 * return type: [ApiController] [Route("api/[controller]")] public class OrdersController.
 */
function readAttributes(masked, stringAt, offset, lineOf) {
  const out = [];
  let k = offset - 1;
  for (;;) {
    while (k >= 0 && masked[k] !== "]" && !/[;{}]/.test(masked[k])) {
      if (masked[k] === ">" || masked[k] === ")") {
        // generic return type or tuple: skip back over the bracket
        let depth = 0;
        const close = masked[k];
        const open = close === ">" ? "<" : "(";
        for (; k >= 0; k--) {
          if (masked[k] === close) depth++;
          else if (masked[k] === open && --depth === 0) break;
        }
      }
      k--;
    }
    if (k < 0 || masked[k] !== "]") break;
    // Find the matching "[".
    let depth = 0;
    let j = k;
    for (; j >= 0; j--) {
      if (masked[j] === "]") depth++;
      else if (masked[j] === "[" && --depth === 0) break;
    }
    if (j < 0) break;
    const before = skipSpaceBack(masked, j - 1);
    // `int[] Foo()` is an array type, not an attribute: attributes follow a statement end, another attribute or the file start.
    if (before >= 0 && !/[;{}\]]/.test(masked[before])) {
      k = j - 1;
      continue;
    }
    out.unshift(...parseAttributeBlock(masked, stringAt, j, k, lineOf));
    k = j - 1;
  }
  return out;
}

/** "[HttpGet("{id}"), Authorize(Roles = "Admin")]" -> [{name, args, strings, named, line}] */
function parseAttributeBlock(masked, stringAt, open, close, lineOf) {
  const out = [];
  for (const part of splitTopLevel(masked, open + 1, close)) {
    const src = masked.slice(part.start, part.end);
    const m = /^\s*(?:\w+\s*:\s*)?([A-Za-z_][\w.]*)\s*(\()?/.exec(src);
    if (!m) continue;
    const name = m[1].split(".").pop().replace(/Attribute$/, "");
    const strings = [];
    const named = {};
    if (m[2]) {
      const aOpen = part.start + m.index + m[0].length - 1;
      const aClose = matchBracket(masked, aOpen);
      for (const a of splitTopLevel(masked, aOpen + 1, aClose)) {
        const text = masked.slice(a.start, a.end);
        const nm = /^\s*(\w+)\s*=\s*/.exec(text);
        const lit = stringAt.get(skipSpace(masked, nm ? a.start + nm[0].length : a.start));
        if (nm) named[nm[1]] = lit ? lit.value : text.slice(nm[0].length).trim();
        else if (lit) strings.push(lit.value);
      }
    }
    out.push({ name, strings, named, line: lineOf(part.start) });
  }
  return out;
}

/** [Authorize], [Authorize("Policy")], [Authorize(Policy = "x", Roles = "A,B")], [AllowAnonymous] */
export function authFromAttributes(attrs) {
  const auth = { authorize: false, anonymous: null, policies: [], roles: [] };
  for (const a of attrs) {
    if (a.name === "AllowAnonymous") auth.anonymous = { line: a.line };
    if (a.name === "Authorize") {
      auth.authorize = true;
      const policy = a.named.Policy ?? a.strings[0];
      if (policy) auth.policies.push({ name: policy, line: a.line });
      if (a.named.Roles) for (const r of String(a.named.Roles).split(",").map((x) => x.trim()).filter(Boolean)) auth.roles.push({ name: r, line: a.line });
    }
  }
  return auth;
}

/**
 * Reads `[Permission.X] = <roles>` entries, resolving named Role[] arrays and `..` spreads written in the same file.
 * A wrapper function applied to the whole dictionary (WithExtraRole(new() { ... })) is reported, not run.
 */
function readPermissionDefaults(masked, lineOf, PERM, ROLE) {
  const P = reEscape(PERM);
  const R = reEscape(ROLE);
  const named = {};
  for (const m of masked.matchAll(new RegExp(`\\b${R}\\s*\\[\\s*\\]\\s+(\\w+)\\s*=\\s*\\[`, "g"))) {
    const open = m.index + m[0].length - 1;
    named[m[1]] = { text: masked.slice(open + 1, matchBracket(masked, open)), line: lineOf(m.index) };
  }
  const resolve = (expr, depth = 0) => {
    const e = expr.trim();
    if (new RegExp(`^Enum\\s*\\.\\s*GetValues\\s*<\\s*${R}\\s*>\\s*\\(\\s*\\)$`).test(e)) return { roles: ["*"], unresolved: [] };
    let inner = e;
    if (e.startsWith("[") && e.endsWith("]")) inner = e.slice(1, -1);
    else if (named[e] && depth < 4) return resolve(`[${named[e].text}]`, depth + 1);
    else return { roles: [], unresolved: [e] };
    const roles = [];
    const unresolved = [];
    for (const part of inner.split(",").map((s) => s.trim()).filter(Boolean)) {
      const role = new RegExp(`^${R}\\.(\\w+)$`).exec(part);
      const spread = /^\.\.\s*(\w+)$/.exec(part);
      if (role) roles.push(role[1]);
      else if (spread && named[spread[1]] && depth < 4) {
        const r = resolve(`[${named[spread[1]].text}]`, depth + 1);
        roles.push(...r.roles);
        unresolved.push(...r.unresolved);
      } else unresolved.push(part);
    }
    return { roles: [...new Set(roles)], unresolved };
  };
  const entries = [];
  for (const m of masked.matchAll(new RegExp(`\\[\\s*${P}\\.(\\w+)\\s*\\]\\s*=\\s*`, "g"))) {
    const start = m.index + m[0].length;
    let depth = 0;
    let end = start;
    for (; end < masked.length; end++) {
      const c = masked[end];
      if (c === "[" || c === "(" || c === "{") depth++;
      else if (c === "]" || c === ")" || c === "}") {
        if (depth === 0) break;
        depth--;
      } else if (c === "," && depth === 0) break;
    }
    entries.push({ permission: m[1], line: lineOf(m.index), expr: masked.slice(start, end).replace(/\s+/g, " ").trim(), ...resolve(masked.slice(start, end)) });
  }
  const wrapper = /=\s*(\w+)\s*\(\s*new\s*(?:Dictionary\s*<[^>]*>)?\s*\(\s*\)/.exec(masked);
  let wrapperInfo = null;
  if (wrapper) {
    const decl = new RegExp(`\\b${wrapper[1]}\\s*\\(`).exec(masked.slice(wrapper.index + wrapper[0].length));
    const declAt = decl ? wrapper.index + wrapper[0].length + decl.index : -1;
    const body = declAt >= 0 ? masked.slice(declAt, statementEnd(masked, declAt)) : "";
    const adds = new RegExp(`Contains\\s*\\(\\s*${R}\\.(\\w+)\\s*\\)\\s*\\?\\s*\\[\\s*\\.\\.\\s*\\w+\\.Value\\s*,\\s*${R}\\.(\\w+)\\s*\\]`).exec(body);
    wrapperInfo = { name: wrapper[1], line: lineOf(wrapper.index), declLine: declAt >= 0 ? lineOf(declAt) : null, ifHas: adds?.[1] ?? null, adds: adds?.[2] ?? null };
  }
  return { entries, named: Object.fromEntries(Object.entries(named).map(([k, v]) => [k, v.line])), wrapper: wrapperInfo };
}

/** Reads enum members with their values and doc summaries. */
function readEnum(masked, rawLines, lineOf, type) {
  const members = [];
  let next = 0;
  for (const part of splitTopLevel(masked, type.bodyStart + 1, type.bodyEnd)) {
    const src = masked.slice(part.start, part.end).replace(/\[[^\]]*\]/g, " ");
    const m = /([A-Za-z_]\w*)\s*(?:=\s*([^,]+))?\s*$/.exec(src.trim());
    if (!m) continue;
    const value = m[2] !== undefined && /^-?\d+$/.test(m[2].trim()) ? Number(m[2].trim()) : m[2] === undefined ? next : null;
    if (value !== null) next = value + 1;
    const off = part.start + src.indexOf(m[1]);
    const line = lineOf(off);
    members.push({ name: m[1], value, line, summary: docAbove(rawLines, line) });
  }
  return { name: type.name, line: type.line, members };
}

/** The /// doc comment directly above a 1-based line (skipping attributes), as plain text. */
function docAbove(rawLines, line) {
  const doc = [];
  for (let l = line - 2; l >= 0; l--) {
    const t = rawLines[l].trim();
    if (t.startsWith("///")) doc.unshift(t.slice(3).trim());
    else if (t.startsWith("[") && doc.length === 0) continue;
    else break;
  }
  if (!doc.length) return null;
  const textOut = doc
    .join(" ")
    .replace(/<see\s+cref="(?:[A-Z]:)?([^"]+)"\s*\/>/g, "$1")
    .replace(/<paramref\s+name="([^"]+)"\s*\/>/g, "$1")
    .replace(/<\/?(summary|remarks|para|c|code|list|item|description|term)[^>]*>/g, " ")
    .replace(/<param name="[^"]*">.*?<\/param>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  return textOut ? textOut.slice(0, 600) : null;
}

/** Table names after FROM / JOIN / INTO / UPDATE / DELETE FROM in a SQL string, minus CTE names. */
export function sqlTables(sql) {
  const lower = sql.toLowerCase();
  const ctes = new Set();
  for (const m of lower.matchAll(/(?:\bwith\s+(?:recursive\s+)?|,\s*)([a-z_][a-z0-9_]*)\s*(?:\([^)]*\)\s*)?as\s*(?:not\s+)?(?:materialized\s+)?\(/g)) ctes.add(m[1]);
  const found = new Map();
  const unknown = new Set();
  const re = /\b(from|join|into|update|delete\s+from|truncate(?:\s+table)?)\s+(?:only\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)\b"?/g;
  for (const m of lower.matchAll(re)) {
    const verb = m[1].replace(/\s+/g, " ");
    const name = m[2];
    const next = lower.slice(m.index + m[0].length).trimStart()[0];
    // `alias.column` is not a table; `FROM unnest(...)` is a function; `INTO jobs (a, b)` is a column list.
    if (next === ".") continue;
    if (next === "(" && (verb === "from" || verb === "join")) continue;
    if (ctes.has(name) || SQL_WORDS.has(name)) continue;
    // `DO UPDATE SET` (upsert) and `FOR UPDATE` are not table names.
    if (verb === "update" && /\b(do|for)\s+$/.test(lower.slice(Math.max(0, m.index - 8), m.index))) continue;
    // `EXTRACT(x FROM y)`, `substring(a from b)`: FROM inside a function call, not a table.
    if (verb === "from" && insideFunctionCall(lower, m.index)) continue;
    const op = verb === "from" || verb === "join" ? "read" : "write";
    const prev = found.get(name);
    found.set(name, prev && prev !== op ? "read/write" : op);
  }
  const tables = [...found].map(([name, op]) => ({ name, op }));
  return { tables, unknown: [...unknown] };
}

const SQL_WORDS = new Set(["select", "set", "lateral", "values", "the", "a", "an", "where", "on", "and", "or", "not", "null", "true", "false", "unnest", "generate_series", "jsonb_array_elements", "jsonb_to_recordset"]);

function insideFunctionCall(lower, at) {
  let depth = 0;
  for (let i = at - 1; i >= 0 && i > at - 400; i--) {
    const c = lower[i];
    if (c === ")") depth++;
    else if (c === "(") {
      if (depth === 0) {
        const before = lower.slice(Math.max(0, i - 20), i);
        return /\b(extract|substring|trim|overlay|position)\s*$/.test(before);
      }
      depth--;
    }
  }
  return false;
}

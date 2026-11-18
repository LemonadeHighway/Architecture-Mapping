// Extracts facts from one TypeScript / JavaScript file with the TypeScript compiler's parser (syntax only, no type
// checking). The parser is borrowed from the project being scanned (its node_modules), so nothing is installed:
//   imports, exported names, HTTP calls (fetch, axios, api.get(...), apiGet(...)-style helpers) with their paths
//   resolved as far as the file itself allows, permission checks, screens (React Router routes, switch-based routers),
//   and navigation entries.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";

let ts = null;
let tsFrom = null;

/** Loads TypeScript from the first candidate folder whose node_modules has it. Returns null if none does. */
export function loadTypeScript(candidates) {
  if (ts) return ts;
  const dirs = [process.env.TYPESCRIPT_PATH, ...candidates].filter(Boolean);
  for (const dir of dirs) {
    const pkg = existsSync(join(dir, "package.json")) && /[\\/]typescript$/.test(dir) ? join(dir, "package.json") : join(dir, "node_modules", "typescript", "package.json");
    if (!existsSync(pkg)) continue;
    try {
      ts = createRequire(pkg)("typescript");
      tsFrom = pkg.replace(/[\\/]package\.json$/, "");
      return ts;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

export function typescriptInfo() {
  return ts ? { version: ts.version, from: tsFrom } : null;
}

const BUILT_IN_FUNCS = { fetch: null, $fetch: null, useFetch: null, axios: null };
const VERB_SUFFIX = /^(?:api|http|request|send|call)(Get|Post|Put|Patch|Delete)$/i;
const CLIENT_METHODS = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE", del: "DELETE", head: "HEAD" };
const WILD = "\u0000";

/**
 * opts: { apiFunctions: {name: verb}, apiClients: [names], permissionChecks: [names], screenFile: boolean,
 *         permissionType: name of a string-union type listing permissions }
 */
export function scanTypeScript(text, path, opts = {}) {
  const kind = /\.tsx$/.test(path) ? ts.ScriptKind.TSX : /\.jsx$/.test(path) ? ts.ScriptKind.JSX : /\.(js|mjs|cjs)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const apiFunctions = { ...(opts.apiFunctions ?? {}) };
  const clients = new Set(opts.apiClients ?? []);
  const permChecks = new Set(opts.permissionChecks ?? []);
  const verbOf = (name) => {
    if (apiFunctions[name] !== undefined) return apiFunctions[name];
    const m = VERB_SUFFIX.exec(name);
    return m ? m[1].toUpperCase() : undefined;
  };
  const stripped = stripComments(text);
  const result = {
    kind: "typescript",
    imports: [],
    exports: [],
    components: [],
    apiCalls: [],
    permissionChecks: [],
    screens: [],
    routes: [],
    navItems: [],
    summary: headerComment(text),
    lines: text.split("\n").length,
    parseErrors: sf.parseDiagnostics?.length ?? 0,
    definesApiHelper: false,
    raw: {
      // Call sites only: `export function apiGet<T>(` is a helper's own declaration, not a call.
      apiCalls: count(stripped, /(?<!function\s+)\b(?:api|http|request|send|call)(?:Get|Post|Put|Patch|Delete)\s*[<(]/gi) + Object.keys(opts.apiFunctions ?? {}).reduce((n, f) => n + count(stripped, new RegExp(`(?<!function\\s+|\\.)\\b${f.replace(/[$]/g, "\\$")}\\s*[<(]`, "g")), 0),
      fetchCalls: count(stripped, /(?<!function\s+|\.)\b(?:fetch|\$fetch|useFetch)\s*\(/g),
      clientCalls: [...clients].reduce((n, c) => n + count(stripped, new RegExp(`(?<![\\w$])${c.replace(/[$]/g, "\\$")}\\s*\\.\\s*(?:get|post|put|patch|delete|del|head|request)\\s*[<(]`, "g")), 0),
    },
  };

  // File-level declarations we can evaluate: const NAME = <expr>, function f(params) { return <expr> }.
  const consts = new Map();
  const funcs = new Map();
  const visitDecl = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) funcs.set(node.name.text, init);
      else consts.set(node.name.text, init);
    }
    if (ts.isFunctionDeclaration(node) && node.name) funcs.set(node.name.text, node);
    ts.forEachChild(node, visitDecl);
  };
  visitDecl(sf);

  const returnedExpr = (fn) => {
    if (!fn.body) return null;
    if (!ts.isBlock(fn.body)) return fn.body;
    const ret = fn.body.statements.filter(ts.isReturnStatement);
    return ret.length === 1 ? ret[0].expression ?? null : null;
  };

  /** Evaluates an expression to a list of alternatives, each a string where WILD marks an unknown part. */
  const evaluate = (node, bindings, depth) => {
    if (!node || depth > 4) return [WILD];
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return evaluate(node.expression, bindings, depth);
    if (ts.isTemplateExpression(node)) {
      let alts = [node.head.text];
      for (const span of node.templateSpans) {
        const part = evaluate(span.expression, bindings, depth + 1);
        const next = [];
        for (const a of alts) for (const p of part) next.push(a + p + span.literal.text);
        alts = next.slice(0, 8);
      }
      return alts;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = evaluate(node.left, bindings, depth + 1);
      const r = evaluate(node.right, bindings, depth + 1);
      return l.flatMap((a) => r.map((b) => a + b)).slice(0, 8);
    }
    if (ts.isConditionalExpression(node)) {
      const alts = [...evaluate(node.whenTrue, bindings, depth + 1), ...evaluate(node.whenFalse, bindings, depth + 1)];
      // `cond ? "?a=1" : ""` is a query string: drop it rather than multiply alternatives.
      if (alts.every((a) => a === "" || a.startsWith("?") || a.startsWith("&"))) return [""];
      return [...new Set(alts)].slice(0, 8);
    }
    if (ts.isIdentifier(node)) {
      if (bindings && bindings.has(node.text)) return bindings.get(node.text);
      if (consts.has(node.text)) return evaluate(consts.get(node.text), null, depth + 1);
      return [WILD];
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && funcs.has(node.expression.text)) {
      const fn = funcs.get(node.expression.text);
      const expr = returnedExpr(fn);
      if (!expr) return [WILD];
      const inner = new Map();
      fn.parameters.forEach((p, i) => {
        if (ts.isIdentifier(p.name)) inner.set(p.name.text, node.arguments[i] ? evaluate(node.arguments[i], bindings, depth + 1) : [WILD]);
      });
      return evaluate(expr, inner, depth + 1);
    }
    return [WILD];
  };

  /** The function (declaration or arrow) a node sits in, and the name it is known by in this file. */
  const enclosingFunction = (node) => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isFunctionDeclaration(p) && p.name) return { fn: p, name: p.name.text };
      if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && p.parent && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) return { fn: p, name: p.parent.name.text };
      if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p) || ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p))) return { fn: p, name: null };
    }
    return null;
  };

  const callSitesOf = (name) => {
    const sites = [];
    const walk = (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) sites.push(n);
      ts.forEachChild(n, walk);
    };
    walk(sf);
    return sites;
  };

  const recordCall = (callNode, method, pathNode, via) => {
    let alts = evaluate(pathNode, null, 0);
    let viaSites = null;
    // The path is a parameter of a local helper (sendForm(path, form) -> fetch(path, ...)): use the helper's callers.
    if (alts.every((a) => a.startsWith(WILD)) && ts.isIdentifier(pathNode)) {
      const enc = enclosingFunction(callNode);
      const idx = enc?.fn.parameters?.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === pathNode.text) ?? -1;
      if (enc?.name && idx >= 0) {
        const sites = callSitesOf(enc.name).filter((s) => s !== callNode);
        if (sites.length) {
          viaSites = sites.map((s) => ({ line: lineOf(s), alts: evaluate(s.arguments[idx], null, 0) }));
        }
      }
    }
    const entries = viaSites ?? [{ line: lineOf(callNode), alts }];
    for (const e of entries) {
      for (const alt of e.alts) {
        result.apiCalls.push({
          method,
          path: alt.split("?")[0].replaceAll(WILD, "{*}"),
          resolved: !alt.split("?")[0].startsWith(WILD),
          hasWildcards: alt.split("?")[0].includes(WILD),
          line: e.line,
          helperLine: viaSites ? lineOf(callNode) : null,
          site: callNode.getStart(sf), // where the call itself is written (two calls can share a line)
          via,
          text: sf.text.slice(callNode.getStart(sf), Math.min(callNode.getEnd(), callNode.getStart(sf) + 160)).replace(/\s+/g, " "),
        });
      }
    }
  };

  const visit = (node) => {
    // Imports and re-exports.
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const names = [];
      const clause = node.importClause;
      if (clause?.name) names.push(clause.name.text);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const el of clause.namedBindings.elements) names.push(el.name.text);
      result.imports.push({ spec: node.moduleSpecifier.text, line: lineOf(node), names, typeOnly: !!clause?.isTypeOnly });
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      result.imports.push({ spec: node.arguments[0].text, line: lineOf(node), names: [], dynamic: true });
    }
    // String unions: type Permission = | "EditOrders" | ...
    if (ts.isTypeAliasDeclaration(node) && ts.isUnionTypeNode(node.type)) {
      const values = node.type.types.filter((t) => ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)).map((t) => ({ value: t.literal.text, line: lineOf(t) }));
      if (values.length) (result.unions ??= {})[node.name.text] = values;
    }
    // Exports.
    const mods = ts.canHaveModifiers?.(node) ? ts.getModifiers(node) : node.modifiers;
    const exported = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported) {
      if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) {
        result.exports.push({ name: node.name.text, line: lineOf(node), kind: ts.SyntaxKind[node.kind].replace("Declaration", "") });
        if (ts.isFunctionDeclaration(node) && /^[A-Z]/.test(node.name.text)) result.components.push({ name: node.name.text, line: lineOf(node) });
      }
      if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) if (ts.isIdentifier(d.name)) result.exports.push({ name: d.name.text, line: lineOf(d), kind: "Const" });
      }
    }
    // HTTP calls.
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg0 = node.arguments[0];
      const methodFromInit = (init, fallback) => {
        if (!init || !ts.isObjectLiteralExpression(init)) return fallback;
        const p = init.properties.find((x) => ts.isPropertyAssignment(x) && x.name.getText(sf) === "method");
        if (!p) return fallback;
        return ts.isStringLiteral(p.initializer) || ts.isNoSubstitutionTemplateLiteral(p.initializer) ? p.initializer.text.toUpperCase() : "?";
      };
      const urlFromConfig = (obj) => {
        if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
        return obj.properties.find((x) => ts.isPropertyAssignment(x) && x.name.getText(sf) === "url")?.initializer ?? null;
      };
      if (ts.isIdentifier(callee) && arg0) {
        const fn = callee.text;
        if (fn in BUILT_IN_FUNCS) {
          // fetch(url, { method }), axios(url | { url, method }), $fetch / useFetch (Nuxt)
          const cfgUrl = fn === "axios" ? urlFromConfig(arg0) : null;
          if (cfgUrl) recordCall(node, methodFromInit(arg0, "GET"), cfgUrl, fn);
          else recordCall(node, methodFromInit(node.arguments[1], "GET"), arg0, fn);
        } else {
          const verb = verbOf(fn);
          if (verb !== undefined) recordCall(node, verb ?? methodFromInit(node.arguments[1], "GET"), arg0, fn);
        }
      }
      // client.get(url), axios.post(url, body), this.http.delete(url), api.request({ url, method })
      if (ts.isPropertyAccessExpression(callee) && arg0) {
        const recv = callee.expression;
        const recvName = ts.isIdentifier(recv) ? recv.text : ts.isPropertyAccessExpression(recv) ? recv.name.text : null;
        const m = callee.name.text;
        if (recvName && clients.has(recvName)) {
          if (CLIENT_METHODS[m]) recordCall(node, CLIENT_METHODS[m], arg0, `${recvName}.${m}`);
          else if (m === "request") {
            const u = urlFromConfig(arg0);
            if (u) recordCall(node, methodFromInit(arg0, "GET"), u, `${recvName}.request`);
          }
        }
      }
      // Permission checks on screens: useCan("EditOrders"), can(user, "EditOrders"), hasPermission(...)
      if (ts.isIdentifier(callee) && permChecks.has(callee.text) && node.arguments.length) {
        const lit = node.arguments.find((a) => ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a));
        if (lit) result.permissionChecks.push({ permission: lit.text, line: lineOf(node), via: callee.text });
        else result.permissionChecks.push({ permission: null, line: lineOf(node), via: callee.text, text: node.arguments.map((a) => a.getText(sf)).join(", ").slice(0, 60) });
      }
    }
    // A function in this file that wraps an HTTP call (export function apiGet(path) { return fetch(path) }): its calls
    // elsewhere are the real call sites, so its own fetch counts as "the helper itself".
    if ((ts.isFunctionDeclaration(node) && node.name) || (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))) {
      const name = node.name.text;
      if (verbOf(name) !== undefined) result.definesApiHelper = true;
    }
    // Screens from a switch-based router: `case "orders": return <OrdersPage />` (only in router-like files).
    if (opts.screenFile && ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) {
      const tags = new Set();
      const walk = (n) => {
        if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && ts.isIdentifier(n.tagName) && /^[A-Z]/.test(n.tagName.text)) tags.add(n.tagName.text);
        ts.forEachChild(n, walk);
      };
      node.statements.forEach(walk);
      if (tags.size) result.screens.push({ route: node.expression.text, components: [...tags], line: lineOf(node), kind: "switch" });
    }
    // React Router, JSX form: <Route path="/orders" element={<OrdersPage />} /> or component={OrdersPage}
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && ts.isIdentifier(node.tagName) && node.tagName.text === "Route") {
      const attr = (name) => node.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === name);
      const pathAttr = attr("path");
      const pathValue = pathAttr?.initializer && ts.isStringLiteral(pathAttr.initializer) ? pathAttr.initializer.text : attr("index") ? "(index)" : null;
      const comps = new Set();
      for (const key of ["element", "component", "Component"]) {
        const a = attr(key);
        if (!a?.initializer) continue;
        const walk = (n) => {
          if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && ts.isIdentifier(n.tagName) && /^[A-Z]/.test(n.tagName.text)) comps.add(n.tagName.text);
          if (ts.isIdentifier(n) && /^[A-Z]/.test(n.text) && key !== "element") comps.add(n.text);
          ts.forEachChild(n, walk);
        };
        walk(a.initializer);
      }
      if (pathValue) result.screens.push({ route: pathValue, components: [...comps], line: lineOf(node), kind: "react-router" });
    }
    // Navigation entries and object routes: { path: "/orders", element: <OrdersPage /> } / { id, label, summary }
    if (ts.isObjectLiteralExpression(node)) {
      const propNode = (name) => node.properties.find((x) => ts.isPropertyAssignment(x) && x.name.getText(sf) === name);
      const prop = (name) => {
        const p = propNode(name);
        return p && (ts.isStringLiteral(p.initializer) || ts.isNumericLiteral(p.initializer) || ts.isNoSubstitutionTemplateLiteral(p.initializer)) ? p.initializer.text : null;
      };
      const pathValue = prop("path");
      const el = propNode("element") ?? propNode("Component") ?? propNode("component");
      if (pathValue !== null && el) {
        const comps = new Set();
        const walk = (n) => {
          if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && ts.isIdentifier(n.tagName) && /^[A-Z]/.test(n.tagName.text)) comps.add(n.tagName.text);
          if (ts.isIdentifier(n) && /^[A-Z]/.test(n.text)) comps.add(n.text);
          ts.forEachChild(n, walk);
        };
        walk(el.initializer);
        result.screens.push({ route: pathValue || "(index)", components: [...comps], line: lineOf(node), kind: "route-object" });
      }
      const id = prop("id") ?? pathValue;
      const label = prop("label") ?? prop("title");
      if (id && label) result.navItems.push({ id, label, summary: prop("summary") ?? prop("description"), phase: prop("phase") ? Number(prop("phase")) : null, line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return result;
}

function count(s, re) {
  let n = 0;
  for (const _ of s.matchAll(re)) n++;
  return n;
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** The comment block at the top of the file (the project writes a plain-language summary there). */
function headerComment(text) {
  const lines = text.split("\n");
  const out = [];
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith("//")) out.push(t.replace(/^\/\/\s?/, ""));
    else if (t.startsWith("/**") || t.startsWith("*") || t.startsWith("/*")) out.push(t.replace(/^\/?\*+\/?\s?/, ""));
    else break;
  }
  const s = out.join(" ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, 600) : null;
}

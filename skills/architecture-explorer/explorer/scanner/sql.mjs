// Reads one PostgreSQL migration into a list of statements, and replays every migration, in file order, into the
// final schema: tables, columns, foreign keys, indexes, functions and triggers. Statements it doesn't model are kept
// in `unmodeled` with their line, so coverage can show them instead of hiding them.
import { lineIndex } from "./text.mjs";

/** Splits a migration into statements: [{sql (comments stripped, lowercased keywords kept), line, raw}]. */
export function scanMigration(text, path) {
  const lineOf = lineIndex(text);
  const statements = [];
  let buf = "";
  let start = -1;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "-" && text[i + 1] === "-") {
      const e = text.indexOf("\n", i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (start < 0 && !/\s/.test(c)) start = i;
    if (c === "'") {
      const e = endOfQuoted(text, i, "'");
      buf += text.slice(i, e);
      i = e;
      continue;
    }
    if (c === '"') {
      const e = endOfQuoted(text, i, '"');
      buf += text.slice(i, e);
      i = e;
      continue;
    }
    if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 40));
      if (tag) {
        const e = text.indexOf(tag[0], i + tag[0].length);
        const stop = e < 0 ? n : e + tag[0].length;
        buf += text.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (c === ";") {
      if (buf.trim()) statements.push({ sql: buf.trim(), line: lineOf(start) });
      buf = "";
      start = -1;
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  if (buf.trim()) statements.push({ sql: buf.trim(), line: lineOf(start) });
  const number = /(\d{4})_/.exec(path.split("/").pop() ?? "");
  const noComments = text.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const raw = {
    createTable: (noComments.match(/\bcreate\s+(?:unlogged\s+)?table\b/gi) ?? []).length,
    alterTable: (noComments.match(/\balter\s+table\b/gi) ?? []).length,
  };
  return { kind: "migration", number: number ? number[1] : null, statements, lines: text.split("\n").length, raw };
}

function endOfQuoted(text, i, q) {
  let k = i + 1;
  while (k < text.length) {
    if (text[k] === q) {
      if (text[k + 1] === q) {
        k += 2;
        continue;
      }
      return k + 1;
    }
    k++;
  }
  return k;
}

const ident = (s) => s.replace(/"/g, "").replace(/^public\./i, "").toLowerCase();

/** Replays migrations (sorted by path) into the final schema. */
export function replaySchema(migrations) {
  const tables = new Map();
  const functions = new Map();
  const triggers = [];
  const unmodeled = [];
  const dropped = [];
  const counts = { statements: 0, createTable: 0, alterActions: 0, alterModeled: 0, createIndex: 0, functions: 0, triggers: 0, views: 0, policies: 0, other: 0 };
  const loc = (file, line) => ({ file, line });

  for (const { path, data } of migrations) {
    for (const st of data.statements) {
      counts.statements++;
      const sql = st.sql;
      const head = sql.replace(/\s+/g, " ").slice(0, 160).toLowerCase();
      const at = loc(path, st.line);
      let m;
      if (/^(begin|commit|rollback|set |reset |grant |revoke |comment on |analyze |vacuum )/.test(head)) continue;

      if ((m = /^create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?("?[\w.]+"?)\s*\(/i.exec(sql))) {
        counts.createTable++;
        const name = ident(m[1]);
        const body = sql.slice(m[0].length, sql.lastIndexOf(")"));
        const table = { name, created: at, altered: [], columns: [], fks: [], indexes: [], triggers: [], policies: [], rls: false, rlsForced: false, checks: 0, history: [{ ...at, what: "created" }] };
        for (const part of splitParts(body)) applyTableElement(table, part, at, true);
        tables.set(name, table);
        continue;
      }
      if ((m = /^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?("?[\w.]+"?)\s+([\s\S]*)$/i.exec(sql))) {
        const name = ident(m[1]);
        const table = tables.get(name);
        const actions = splitParts(m[2]);
        for (const action of actions) {
          counts.alterActions++;
          if (!table) {
            unmodeled.push({ ...at, what: `ALTER TABLE ${name} (table not created by an earlier migration)`, text: action.slice(0, 120) });
            continue;
          }
          const ok = applyAlter(table, tables, action, at);
          if (ok) counts.alterModeled++;
          else unmodeled.push({ ...at, what: `ALTER TABLE ${name}`, text: action.replace(/\s+/g, " ").slice(0, 140) });
        }
        if (table && !table.altered.some((a) => a.file === path)) table.altered.push(at);
        continue;
      }
      if ((m = /^drop\s+table\s+(?:if\s+exists\s+)?([\s\S]+?)(?:\s+(cascade|restrict))?$/i.exec(sql))) {
        for (const raw of m[1].split(",")) {
          const name = ident(raw.trim());
          if (tables.has(name)) {
            dropped.push({ name, created: tables.get(name).created, dropped: at });
            tables.delete(name);
          }
        }
        continue;
      }
      if ((m = /^create\s+(unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?("?\w+"?)?\s*on\s+(?:only\s+)?("?[\w.]+"?)\s*(?:using\s+\w+\s*)?\(([\s\S]*?)\)/i.exec(sql))) {
        counts.createIndex++;
        const table = tables.get(ident(m[3]));
        if (table) table.indexes.push({ name: m[2] ? ident(m[2]) : null, unique: !!m[1], columns: m[4].replace(/\s+/g, " ").trim(), ...at });
        else unmodeled.push({ ...at, what: "CREATE INDEX on unknown table", text: head });
        continue;
      }
      if ((m = /^drop\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?("?[\w.]+"?)/i.exec(sql))) {
        const name = ident(m[1]);
        for (const t of tables.values()) t.indexes = t.indexes.filter((x) => x.name !== name);
        continue;
      }
      if ((m = /^create\s+(?:or\s+replace\s+)?function\s+("?[\w.]+"?)\s*\(/i.exec(sql))) {
        counts.functions++;
        const name = ident(m[1]);
        const bodyTables = new Set();
        for (const t of sql.toLowerCase().matchAll(/\b(?:from|join|into|update)\s+(?:only\s+)?([a-z_][a-z0-9_]*)/g)) bodyTables.add(t[1]);
        functions.set(name, { name, ...at, bodyTables: [...bodyTables] });
        continue;
      }
      if ((m = /^drop\s+function\s+(?:if\s+exists\s+)?("?[\w.]+"?)/i.exec(sql))) {
        functions.delete(ident(m[1]));
        continue;
      }
      if ((m = /^create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+("?\w+"?)\s+([\s\S]*?)\bon\s+("?[\w.]+"?)[\s\S]*?execute\s+(?:function|procedure)\s+("?[\w.]+"?)/i.exec(sql))) {
        counts.triggers++;
        const tr = { name: ident(m[1]), timing: m[2].replace(/\s+/g, " ").trim(), table: ident(m[3]), fn: ident(m[4]), ...at };
        triggers.push(tr);
        tables.get(tr.table)?.triggers.push(tr);
        continue;
      }
      if ((m = /^drop\s+trigger\s+(?:if\s+exists\s+)?("?\w+"?)\s+on\s+("?[\w.]+"?)/i.exec(sql))) {
        const name = ident(m[1]);
        const table = tables.get(ident(m[2]));
        if (table) table.triggers = table.triggers.filter((t) => t.name !== name);
        const idx = triggers.findIndex((t) => t.name === name && t.table === ident(m[2]));
        if (idx >= 0) triggers.splice(idx, 1);
        continue;
      }
      if ((m = /^create\s+policy\s+("?\w+"?)\s+on\s+("?[\w.]+"?)([\s\S]*)$/i.exec(sql))) {
        counts.policies++;
        const table = tables.get(ident(m[2]));
        const using = (/\busing\s*\(([\s\S]*?)\)\s*(?:with\s+check|$)/i.exec(m[3]) ?? [])[1] ?? null;
        if (table) table.policies.push({ name: ident(m[1]), using: using ? using.replace(/\s+/g, " ").trim() : null, ...at });
        else unmodeled.push({ ...at, what: "CREATE POLICY on unknown table", text: head });
        continue;
      }
      if ((m = /^drop\s+policy\s+(?:if\s+exists\s+)?("?\w+"?)\s+on\s+("?[\w.]+"?)/i.exec(sql))) {
        const table = tables.get(ident(m[2]));
        if (table) table.policies = table.policies.filter((p) => p.name !== ident(m[1]));
        continue;
      }
      if (/^create\s+(or\s+replace\s+)?(materialized\s+)?view/i.test(sql)) {
        counts.views++;
        unmodeled.push({ ...at, what: "CREATE VIEW (not modeled)", text: head });
        continue;
      }
      if (/^create\s+(temp|temporary)\s+table/i.test(head)) {
        counts.other++;
        continue; // a scratch table that lives only while the migration runs
      }
      if (/^do\b/i.test(head)) {
        // A DO block runs dynamic SQL (EXECUTE format(...)). Its effect can't be replayed statically: record which
        // tables it names, so a missing policy there reads "not analyzed", never "missing".
        counts.doBlocks = (counts.doBlocks ?? 0) + 1;
        const lower = sql.toLowerCase();
        const named = [...new Set([...lower.matchAll(/'([a-z_][a-z0-9_]*)'/g)].map((x) => x[1]))].filter((x) => tables.has(x));
        const effect = {
          ...at,
          policy: /\bpolicy\b/.test(lower),
          rls: /row level security/.test(lower),
          trigger: /\btrigger\b/.test(lower),
          grant: /\bgrant\b/.test(lower),
        };
        for (const name of named) (tables.get(name).dynamic ??= []).push(effect);
        unmodeled.push({ ...at, what: `DO block: dynamic SQL, not replayed${named.length ? ` (names ${named.join(", ")})` : ""}`, text: head });
        continue;
      }
      if (/^(insert|update|delete|select|with|truncate)\b/i.test(head)) {
        counts.other++;
        continue; // data changes and checks: not part of the schema's shape
      }
      if (/^create\s+(extension|schema|type|sequence|role|policy)|^alter\s+(sequence|type|role|function|default)|^drop\s+(type|sequence|extension|view|policy)/i.test(head)) {
        counts.other++;
        unmodeled.push({ ...at, what: head.split(" ").slice(0, 2).join(" ").toUpperCase() + " (recorded, not modeled)", text: head });
        continue;
      }
      counts.other++;
      unmodeled.push({ ...at, what: "statement not recognized", text: head });
    }
  }
  // Foreign keys that point at tables dropped later are kept but flagged.
  for (const t of tables.values()) for (const fk of t.fks) fk.targetExists = tables.has(fk.to);
  return { tables: [...tables.values()], functions: [...functions.values()], triggers, unmodeled, dropped, counts };
}

/** Splits a parenthesized body at top-level commas, ignoring quotes. */
function splitParts(body) {
  const parts = [];
  let depth = 0;
  let cur = "";
  let q = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) {
      cur += c;
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const cols = (s) => s.split(",").map((c) => ident(c.trim())).filter(Boolean);

function applyTableElement(table, part, at, inCreate) {
  const p = part.replace(/\s+/g, " ").trim();
  let m;
  const constraintName = (/^constraint\s+("?\w+"?)\s+/i.exec(p) ?? [])[1];
  const body = constraintName ? p.replace(/^constraint\s+("?\w+"?)\s+/i, "") : p;
  if ((m = /^foreign\s+key\s*\(([^)]*)\)\s*references\s+("?[\w.]+"?)\s*(?:\(([^)]*)\))?(.*)$/i.exec(body))) {
    const from = cols(m[1]);
    table.fks.push({
      name: constraintName ? ident(constraintName) : `${table.name}_${from[0]}_fkey`,
      columns: from,
      to: ident(m[2]),
      toColumns: m[3] ? cols(m[3]) : ["id"],
      onDelete: (/on delete (cascade|restrict|set null|set default|no action)/i.exec(m[4]) ?? [])[1] ?? null,
      ...at,
    });
    return true;
  }
  if (/^(primary\s+key|unique|check|exclude)\b/i.test(body)) {
    if (/^primary\s+key/i.test(body)) table.primaryKey = cols((/\(([^)]*)\)/.exec(body) ?? [])[1] ?? "");
    if (/^check/i.test(body)) table.checks++;
    if (/^unique/i.test(body)) table.uniques = [...(table.uniques ?? []), { name: constraintName ? ident(constraintName) : null, columns: (/\(([^)]*)\)/.exec(body) ?? [])[1] ?? "" }];
    return true;
  }
  if (!inCreate) return false;
  // Column definition.
  if ((m = /^("?\w+"?)\s+(.+)$/i.exec(p))) {
    addColumn(table, ident(m[1]), m[2], at);
    return true;
  }
  return false;
}

function addColumn(table, name, def, at) {
  const typeMatch = /^([a-z_][\w ]*?(?:\([^)]*\))?(?:\[\])?)(?=\s+(?:not|null|default|references|primary|unique|check|generated|constraint|collate)\b|\s*$)/i.exec(def.trim());
  const col = {
    name,
    type: (typeMatch ? typeMatch[1] : def.split(" ")[0]).toLowerCase(),
    nullable: !/\bnot null\b/i.test(def) && !/\bprimary key\b/i.test(def),
    default: (/\bdefault\s+([^,]+?)(?=\s+(?:not|null|references|primary|unique|check|constraint)\b|$)/i.exec(def) ?? [])[1] ?? null,
    line: at.line,
    file: at.file,
  };
  table.columns = table.columns.filter((c) => c.name !== name);
  table.columns.push(col);
  if (/\bprimary key\b/i.test(def)) table.primaryKey = [name];
  const ref = /\breferences\s+("?[\w.]+"?)\s*(?:\(([^)]*)\))?([^,]*)/i.exec(def);
  if (ref) {
    table.fks.push({
      name: `${table.name}_${name}_fkey`,
      columns: [name],
      to: ident(ref[1]),
      toColumns: ref[2] ? cols(ref[2]) : ["id"],
      onDelete: (/on delete (cascade|restrict|set null|set default|no action)/i.exec(ref[3]) ?? [])[1] ?? null,
      ...at,
    });
  }
}

function applyAlter(table, tables, action, at) {
  const a = action.replace(/\s+/g, " ").trim();
  let m;
  if ((m = /^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?(?!constraint\b)(?!foreign\b)(?!primary\b)(?!unique\b)(?!check\b)("?\w+"?)\s+(.+)$/i.exec(a))) {
    addColumn(table, ident(m[1]), m[2], at);
    table.history.push({ ...at, what: `column ${ident(m[1])} added` });
    return true;
  }
  if ((m = /^add\s+(.+)$/i.exec(a))) {
    const ok = applyTableElement(table, m[1], at, false);
    if (ok) table.history.push({ ...at, what: `constraint added` });
    return ok;
  }
  if ((m = /^drop\s+column\s+(?:if\s+exists\s+)?("?\w+"?)/i.exec(a))) {
    const c = ident(m[1]);
    table.columns = table.columns.filter((x) => x.name !== c);
    table.fks = table.fks.filter((f) => !f.columns.includes(c));
    table.history.push({ ...at, what: `column ${c} dropped` });
    return true;
  }
  if ((m = /^drop\s+constraint\s+(?:if\s+exists\s+)?("?\w+"?)/i.exec(a))) {
    const c = ident(m[1]);
    table.fks = table.fks.filter((f) => f.name !== c);
    if (table.uniques) table.uniques = table.uniques.filter((u) => u.name !== c);
    return true; // CHECK constraints are counted, not tracked by name
  }
  if ((m = /^rename\s+column\s+("?\w+"?)\s+to\s+("?\w+"?)/i.exec(a))) {
    const from = ident(m[1]);
    const to = ident(m[2]);
    for (const c of table.columns) if (c.name === from) c.name = to;
    for (const f of table.fks) f.columns = f.columns.map((x) => (x === from ? to : x));
    table.history.push({ ...at, what: `column ${from} renamed to ${to}` });
    return true;
  }
  if ((m = /^rename\s+to\s+("?\w+"?)/i.exec(a))) {
    const to = ident(m[1]);
    tables.delete(table.name);
    for (const t of tables.values()) for (const f of t.fks) if (f.to === table.name) f.to = to;
    table.history.push({ ...at, what: `renamed from ${table.name}` });
    table.name = to;
    tables.set(to, table);
    return true;
  }
  if ((m = /^alter\s+(?:column\s+)?("?\w+"?)\s+(.+)$/i.exec(a))) {
    const c = table.columns.find((x) => x.name === ident(m[1]));
    if (!c) return false;
    const rest = m[2];
    let t;
    if ((t = /^(?:set\s+data\s+)?type\s+(.+?)(?:\s+using\s+.*)?$/i.exec(rest))) c.type = t[1].toLowerCase();
    else if (/^set\s+not\s+null/i.test(rest)) c.nullable = false;
    else if (/^drop\s+not\s+null/i.test(rest)) c.nullable = true;
    else if ((t = /^set\s+default\s+(.+)$/i.exec(rest))) c.default = t[1];
    else if (/^drop\s+default/i.test(rest)) c.default = null;
    else return false;
    return true;
  }
  if ((m = /^(enable|disable|force|no force)\s+row level security/i.exec(a))) {
    const v = m[1].toLowerCase();
    if (v === "enable") table.rls = true;
    else if (v === "disable") table.rls = false;
    else if (v === "force") table.rlsForced = true;
    else table.rlsForced = false;
    table.history.push({ ...at, what: `row level security: ${v}` });
    return true;
  }
  if (/^(enable|disable)\s+(always\s+|replica\s+)?trigger/i.test(a) || /^owner\s+to/i.test(a) || /^validate\s+constraint/i.test(a)) return true;
  return false;
}

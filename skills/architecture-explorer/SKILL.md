---
name: architecture-explorer
description: Opens an interactive, live architecture map of the current repository in the browser (Floorplan-style canvas with layers, modules, API routes, database tables, permissions, screens, outside services and the business workflow), where every relationship shows its source file and line and is marked verified, inferred or unresolved. Use it whenever someone wants to see, visualize, map, explore or understand how their system is built or fits together, trace what calls what, find who can access an endpoint, see which tables a feature touches, check security boundaries and permissions, find where a new feature should go, or keep architecture documentation accurate, even if they don't say "architecture explorer". Best for C# / ASP.NET Core backends (minimal APIs or controllers, Dapper or EF Core, SQL migrations) with a React or other TypeScript/JavaScript frontend; other repos get a partial map with honest coverage.
---

# Architecture explorer

A local, read-only tool that scans a repository and shows it as an interactive map in the browser. It is meant for
people building a system who want to understand it as a whole: what the layers are, which screen calls which API
address, which permission guards it, which tables the code reads and writes, and what changed.

The tool lives in `explorer/` next to this file. It has no dependencies of its own: it needs Node.js 20 or later,
and borrows the TypeScript parser from the scanned project's `node_modules` (or from `explorer/node_modules` after a
one-time `npm install` there). It never writes to the repository and only listens on 127.0.0.1.

## What it shows

Eleven views of one scan: Overview, Software architecture, Functional modules, Code structure, Module dependencies,
Frontend ↔ backend, API connections, Database, Business workflow, Security & permissions, External integrations.
Every box can be explored (what uses it / what is inside / what it uses), every line opens its evidence, a side
panel has Health findings, Coverage and Recent work (git changes), and the map updates itself when files change.

Every relationship carries a status, and this matters more than anything else the tool does:

- **verified**: a literal fact in the code with both ends located (an import that resolves, `[Authorize(Policy =
  "x")]` on an action, a handler parameter type, a table name in a SQL string, a foreign key);
- **inferred**: a name match or a convention (a C# identifier equal to a type name, a call path with a dynamic part,
  EF Core's table naming, a workflow step matched by keyword);
- **unresolved**: one end found, the other not (a frontend call that matches no server route).

When you report what the map says, keep those words. Saying "X calls Y" about an inferred edge overstates what the
scan knows; say "X probably calls Y (inferred: <reason>)" instead, and quote the file and line.

## Starting it

1. Find the repository root (the folder with `.git`, or what the user points at).
2. Start the server in the background, so it keeps running and watching while you work:
   ```bash
   node "<this skill's folder>/explorer/server.mjs" --root "<repo root>"
   ```
   It prints `Architecture explorer: http://127.0.0.1:<port>`. The port starts at 5190 and moves up if taken, so
   read it from the output rather than assuming. Add `--port N` to choose one.
3. Open that URL for the user: in the built-in browser if you have one, otherwise give them the link. On a large
   repository the first scan takes a few seconds; the page shows a loading state meanwhile.
4. Run the one-shot summary too, so you know what was detected before you talk about it:
   ```bash
   node "<this skill's folder>/explorer/cli.mjs" --root "<repo root>"
   ```
   It lists the detected C# projects and their layers, the frontend app(s), the migration folders, the coverage
   table and the findings.

If the summary says the TypeScript parser was not found, the frontend files are listed but not analyzed. Offer to
run `npm install` in the explorer folder (it installs only `typescript`), or to install the project's own packages.

## Fitting it to the project

The defaults understand standard ASP.NET Core (`[Authorize]`, `RequireAuthorization`, `AllowAnonymous`,
`AddPolicy`, `IsInRole`, the fallback policy, route groups, controllers with attribute routes), Dapper/raw SQL,
EF Core `DbSet`s, `.sql` migrations, and React/TypeScript frontends (fetch, axios, `api.get(...)` clients,
`apiGet`-style helpers, React Router, Next.js folders).

Many projects have their own conventions on top, most often a permission enum with custom route guards and
checks (`.Requires(Permission.EditOrders)`, `Permissions.Require(user, Permission.X)`, `useCan("EditOrders")` on
screens), or a documented business process. Without them the Security view under-reports: endpoints guarded by a
custom check look "sign-in only". After the first scan, look for these conventions (search the code for a
permission-like enum, extension methods used after `MapGet/MapPost`, and permission checks in handlers and
screens), then propose a `.architecture-explorer.json` at the repository root. Show the user the file before you
write it: it goes into their repository. The format, with examples and how to find each value, is in
`references/configuration.md`. The server notices the new config and rescans by itself.

Check the result rather than assuming it worked: rerun the CLI summary and compare the Security findings before and
after. If the project has a test that lists guarded routes per permission (a `Dictionary<Permission, int>`), the
Coverage tab cross-checks against it automatically, which is the best evidence that the config is right.

## Answering questions with it

Use the CLI for precise answers inside the conversation, and point the user at the map for the picture:

```bash
node "<explorer>/cli.mjs" --root "<repo>" --find "orders"          # nodes whose name, path or route matches
node "<explorer>/cli.mjs" --root "<repo>" --node "POST /api/orders"  # details, who may call it, every relationship + evidence
node "<explorer>/cli.mjs" --root "<repo>" --json snapshot.json       # everything, for your own analysis
```

Node ids look like `endpoint:GET /api/orders`, `file:src/App/Program.cs`, `table:orders`, `perm:EditOrders`,
`perm:policy:Admin`, `role:Admin`, `screen:<file>:<route>`. Typical questions it answers well:

- *Who calls this endpoint / what does this screen call?* `--node` the endpoint or the screen's file.
- *Who can do X?* `--node` the endpoint: "Who may call it" lists route guards, policies, roles and the checks found
  inside the handler (followed four levels into helpers and business rules), each with file and line.
- *Where should a new feature go?* Look at the closest functional area (Functional modules view) and how its folders
  are split across projects and the frontend; propose following the same layout. Present it as a suggestion from
  the existing structure, not a rule.
- *Is anything unprotected / unused / broken?* The findings: addresses that change data with no authorization
  found, sign-in-only writes, frontend calls that match no route, routes nobody calls, permissions with no server
  check, tenant tables without row-level security, secrets in settings files.

## Being honest about what it can't see

The Coverage tab (and the CLI's coverage table) compares raw text matches (every `MapGet`, guard, `[Http*]`
attribute, frontend call, `CREATE TABLE`) with what was understood, and lists every leftover with its file. Mention
the limits that matter for the question: C# is read by a lexer, not compiled (type links are name matches); runtime
behaviour, middleware and gateways are not observed; SQL built at run time, PL/pgSQL bodies and `DO` blocks are
listed, not interpreted; EF Core C# migrations, JavaScript backends, GraphQL and gRPC are not modeled.

A finding is a fact about the code, not a verdict. "Only checks sign-in" can be exactly right for changing your own
password. Report what was found and where, and let the user decide whether it's a problem; offer to fix it.

## Housekeeping

- The server keeps running until stopped. Stop it when the user is done, or when you start one for another repo.
- Nothing leaves the computer: no network calls, no telemetry. The "Ask" bar in the page is index search, not AI.
- Secret-looking values in JSON settings are masked in the source viewer, and only files the scan indexed can be
  opened from the page.

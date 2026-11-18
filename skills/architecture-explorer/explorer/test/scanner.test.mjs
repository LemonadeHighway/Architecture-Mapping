// node --test test/*.test.mjs — the scanners on small inputs, and the whole pipeline on a sample shop (make-fixture.mjs).
// The TypeScript parser comes from this folder's node_modules (npm install) or TYPESCRIPT_PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lexCSharp } from "../scanner/csharp-lexer.mjs";
import { scanCSharp, sqlTables } from "../scanner/csharp.mjs";
import { scanMigration, replaySchema } from "../scanner/sql.mjs";
import { matchRoute } from "../scanner/graph.mjs";
import { loadTypeScript } from "../scanner/typescript.mjs";
import { RepoScanner } from "../scanner/index.mjs";
import { writeFixture } from "./make-fixture.mjs";

const toolDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hasTs = !!loadTypeScript([toolDir]);
const needsTs = hasTs ? {} : { skip: "TypeScript not installed: run npm install in the explorer folder, or set TYPESCRIPT_PATH" };

test("lexer masks comments and every string form, keeping offsets", () => {
  const src = [
    'var a = "x.MapGet(\\"/no\\")"; // api.MapGet("/comment")',
    'var b = @"C:\\path ""quoted""";',
    'var c = $"/orders/{{id:guid}}/{action}";',
    'var d = """',
    "    SELECT * FROM orders",
    '    """;',
    "/* api.MapPost(\"/block\") */ api.MapPut(\"/real\", H);",
  ].join("\n");
  const { masked, strings } = lexCSharp(src);
  assert.equal(masked.length, src.length);
  assert.equal([...masked.matchAll(/Map(Get|Post|Put)/g)].length, 1, "only the real MapPut survives masking");
  assert.equal(strings.find((s) => s.kind === "verbatim").value, 'C:\\path "quoted"');
  assert.equal(strings.find((s) => s.interpolated).value, "/orders/{id:guid}/\u0001action\u0002");
  assert.match(strings.find((s) => s.kind === "raw").value, /SELECT \* FROM orders/);
});

test("C# scanner: groups, a configured guard through a const alias, handlers, SQL tables", () => {
  const r = scanCSharp(
    `namespace X;
public static class E {
  public static void MapThings(this RouteGroupBuilder api) {
    const Permission View = Permission.ViewThings;
    var things = api.MapGroup("/things/{id:guid}");
    things.MapGet("/a", GetAsync).Requires(View);
    api.MapPost("/open", (Guid id) => Results.Ok()).AllowAnonymous();
  }
  private static Task<IResult> GetAsync(Guid id, ThingStore store) => store.LoadAsync(id);
}
public sealed class ThingStore { const string Sql = """
  SELECT t.id FROM things t JOIN thing_parts p ON p.thing_id = t.id
  WHERE EXTRACT(EPOCH FROM t.at) > 0
"""; public Task LoadAsync(Guid id) => Task.CompletedTask; }`,
    "src/X.Api/E.cs",
    { permissionEnum: "Permission", routeGuards: ["Requires"] },
  );
  assert.equal(r.groups[0].prefix, "/things/{id:guid}");
  const get = r.mapCalls.find((m) => m.pattern === "/a");
  assert.deepEqual(get.verbs, ["GET"]);
  assert.equal(get.chain[0].name, "Requires");
  assert.equal(r.constPerms.View, "ViewThings");
  assert.equal(get.handler.name, "GetAsync");
  assert.equal(r.mapCalls.find((m) => m.pattern === "/open").handler.kind, "lambda");
  assert.equal(r.methods.find((m) => m.name === "GetAsync").params[1].baseType, "ThingStore");
  assert.equal(r.methods.find((m) => m.name === "LoadAsync").owner, "ThingStore");
  assert.deepEqual(r.sql[0].tables.map((t) => t.name).sort(), ["thing_parts", "things"]);
});

test("C# scanner: controllers with attribute routes and [Authorize]", () => {
  const r = scanCSharp(
    `[ApiController]
[Route("api/[controller]")]
[Authorize(Policy = "Staff")]
public class OrdersController(OrderStore store) : ControllerBase {
  [HttpGet] public IActionResult List() => Ok();
  [HttpGet("{id:int}"), AllowAnonymous] public IActionResult Get(int id) => Ok();
  [HttpPost("/hooks/[action]")] [Authorize(Roles = "Admin, Ops")] public async Task<IActionResult> Paid() => Ok();
  public int[] Helper() => [];
}`,
    "src/A.Api/OrdersController.cs",
  );
  const eps = r.controllerEndpoints.map((e) => `${e.verb} ${e.route}`).sort();
  assert.deepEqual(eps, ["GET /api/Orders", "GET /api/Orders/{id:int}", "POST /hooks/Paid"]);
  const get = r.controllerEndpoints.find((e) => e.route.endsWith("{id:int}"));
  assert.ok(get.auth.anonymous);
  const paid = r.controllerEndpoints.find((e) => e.verb === "POST");
  assert.deepEqual(paid.auth.roles.map((x) => x.name), ["Admin", "Ops"]);
  assert.deepEqual(paid.auth.policies.map((x) => x.name), ["Staff"]);
  assert.equal(paid.injected[0].baseType, "OrderStore");
});

test("C# scanner: only authorization AddPolicy calls are policies", () => {
  const r = scanCSharp(`builder.Services.AddCors(o => o.AddPolicy("web", p => p.AllowAnyOrigin()));
builder.Services.AddRateLimiter(o => o.AddPolicy("burst", c => null));
builder.Services.AddAuthorization(o => { o.AddPolicy("Admin", p => p.RequireRole("Admin", "Owner")); });`, "Program.cs");
  assert.deepEqual(r.policies.map((p) => p.name), ["Admin"]);
  assert.deepEqual(r.policies[0].roles, ["Admin", "Owner"]);
});

test("SQL helpers skip upserts, CTEs and FROM inside functions", () => {
  const { tables } = sqlTables("WITH recent AS (SELECT * FROM carts) INSERT INTO orders (a) SELECT a FROM recent ON CONFLICT (a) DO UPDATE SET a = EXCLUDED.a");
  assert.deepEqual(tables.map((t) => `${t.name}:${t.op}`).sort(), ["carts:read", "orders:write"]);
});

test("migration replay applies ALTER, RENAME and DROP in order", () => {
  const m1 = scanMigration("CREATE TABLE a (id uuid PRIMARY KEY, name text NOT NULL);\nCREATE TABLE b (id uuid PRIMARY KEY, a_id uuid REFERENCES a (id));", "db/migrations/0001_x.sql");
  const m2 = scanMigration("ALTER TABLE a ADD COLUMN note text, RENAME COLUMN name TO title;\nALTER TABLE a ENABLE ROW LEVEL SECURITY;\nCREATE POLICY p ON a USING (true);\nDROP TABLE b;\nDO $$ BEGIN EXECUTE 'x'; END $$;", "db/migrations/0002_x.sql");
  const s = replaySchema([{ path: "db/migrations/0001_x.sql", data: m1 }, { path: "db/migrations/0002_x.sql", data: m2 }]);
  const a = s.tables.find((t) => t.name === "a");
  assert.deepEqual(a.columns.map((c) => c.name), ["id", "title", "note"]);
  assert.equal(a.rls, true);
  assert.equal(a.policies.length, 1);
  assert.equal(s.tables.some((t) => t.name === "b"), false);
  assert.equal(s.unmodeled.filter((u) => /DO block/.test(u.what)).length, 1, "DO blocks are listed, never silently skipped");
});

test("route matching: exact is verified, dynamic over a fixed segment is not", () => {
  const ep = (verb, route) => ({ id: `${verb} ${route}`, data: { verb, route } });
  const eps = [ep("GET", "/api/orders/{id:guid}"), ep("GET", "/api/orders/recent"), ep("POST", "/api/orders/{id:guid}/notes")];
  assert.deepEqual(matchRoute("GET", "/api/orders/recent", eps), { best: [eps[1]], exact: true });
  assert.deepEqual(matchRoute("GET", "/api/orders/{*}", eps).best, [eps[0]], "a dynamic value prefers the {id} route over a fixed word");
  assert.equal(matchRoute("POST", "/api/orders/{*}/notes", eps).exact, true);
  assert.equal(matchRoute("DELETE", "/api/orders/{*}/notes", eps).best.length, 0);
});

test("the sample shop, end to end", { timeout: 60000, ...needsTs }, () => {
  const root = mkdtempSync(join(tmpdir(), "arch-shop-"));
  try {
    writeFixture(root);
    const { snapshot: s } = new RepoScanner(root, { toolDir }).scan();
    const ep = (id) => s.nodes[`endpoint:${id}`];
    const level = (id) => ep(id)?.data.auth.level;

    // Projects and layers come from the .csproj names.
    assert.deepEqual(s.layout.projects.map((p) => `${p.name}:${p.layer}`).sort(), ["Shop.Api.Tests:tests", "Shop.Api:api", "Shop.Domain:domain", "Shop.Infrastructure:infrastructure"]);
    assert.equal(s.title, "Shop");
    // Minimal APIs: a group with RequireAuthorization, a route policy, an anonymous route and an unprotected one.
    assert.equal(level("GET /api/orders"), "signed-in");
    assert.equal(level("DELETE /api/orders/{id:int}"), "permission-route");
    assert.equal(level("GET /health"), "anonymous");
    assert.equal(level("POST /webhooks/payment"), "no-auth-found");
    assert.equal(level("POST /api/orders"), "permission-allows", "IsInRole in the handler is a branch on a role");
    // Controller actions.
    assert.equal(level("GET /api/Products"), "signed-in");
    assert.equal(level("GET /api/Products/featured"), "anonymous");
    assert.equal(level("DELETE /api/Products/{id:int}"), "permission-route");
    assert.ok(s.edges.some((e) => e.kind === "injects" && e.from === "endpoint:GET /api/Products" && e.to.endsWith("#ProductStore")), "controller constructor injection");
    // Policies and roles: only the authorization policy, not the CORS one.
    assert.ok(s.nodes["perm:policy:Admin"]);
    assert.equal(s.nodes["perm:policy:web"], undefined);
    assert.ok(s.edges.some((e) => e.kind === "default-for" && e.from === "role:Admin" && e.to === "perm:policy:Admin"));
    // Database: replayed migrations, foreign keys, SQL use.
    assert.deepEqual(Object.values(s.nodes).filter((n) => n.type === "table").map((n) => n.label).sort(), ["customers", "order_lines", "orders", "products"]);
    assert.ok(s.nodes["table:orders"].data.columns.some((c) => c.name === "placed_at"));
    assert.ok(s.edges.some((e) => e.kind === "fk" && e.from === "table:order_lines" && e.to === "table:products"));
    assert.ok(s.edges.some((e) => e.kind === "reads" && e.from.endsWith("#OrderStore") && e.to === "table:customers"));
    assert.ok(s.edges.some((e) => e.kind === "writes" && e.to === "table:order_lines"));
    // Frontend: fetch, axios, a helper and an API client, all matched; one call to a route that doesn't exist.
    const calls = (to) => s.edges.filter((e) => e.kind === "calls-api" && e.to === to);
    assert.equal(calls("endpoint:GET /api/orders")[0]?.status, "verified");
    assert.ok(calls("endpoint:POST /api/orders").length, "apiPost helper");
    assert.ok(calls("endpoint:DELETE /api/orders/{id:int}").length, "axios.delete with a template");
    assert.ok(calls("endpoint:GET /api/Products/featured").length, "api.get client");
    assert.ok(calls("endpoint:DELETE /api/Products/{id:int}").length, "api.delete client, case-insensitive route");
    assert.ok(s.findings.some((f) => /match no API route/.test(f.title) && f.evidence.some((e) => /\/api\/discounts/.test(e.note))));
    // Screens from createBrowserRouter, and what they reach.
    assert.deepEqual(Object.values(s.nodes).filter((n) => n.type === "screen").map((n) => n.data.route).sort(), ["/", "/products"]);
    assert.ok(s.edges.some((e) => e.kind === "reaches-api" && e.to === "endpoint:GET /api/orders"));
    // Screen permission check matched to the server policy.
    assert.ok(s.edges.some((e) => e.kind === "checks-permission" && e.to === "perm:policy:Admin"));
    // Outside services: Stripe from a URL and a package, PostgreSQL from Npgsql.
    assert.ok(s.nodes["ext:api.stripe.com"]);
    assert.ok(s.nodes["ext:svc:stripe"]);
    assert.ok(s.edges.some((e) => e.kind === "hosts" && e.from === "ext:svc:postgresql"));
    // Tests: xUnit methods and the route a test names.
    assert.equal(s.nodes["file:tests/Shop.Api.Tests/OrdersTests.cs"].data.tests.methods, 2);
    assert.ok(s.edges.some((e) => e.kind === "tests" && e.to === "endpoint:GET /api/orders"));
    // Workflow from the configured document.
    assert.equal(Object.values(s.nodes).filter((n) => n.type === "step").length, 3);
    assert.ok(s.edges.some((e) => e.kind === "step-in" && e.from === "step:2"));
    // Findings: the open webhook is important; a doc link to a missing file is listed.
    assert.ok(s.findings.some((f) => f.severity === "important" && f.evidence.some((e) => /webhooks\/payment/.test(e.note))));
    assert.ok(s.findings.some((f) => /don't exist/.test(f.title) && f.evidence.some((e) => /missing\.md/.test(e.note))));
    // Every verified edge carries a source location.
    for (const e of s.edges.filter((x) => x.status === "verified")) assert.ok(e.evidence[0]?.file, `verified edge ${e.id} has a source file`);
    // Coverage reconciles: nothing found by text was missed by the parsers.
    for (const row of s.coverage.rows.filter((r) => /route mappings|Controller actions|Frontend HTTP|imports|CREATE TABLE/.test(r.area))) assert.equal(row.left, 0, `${row.area}: ${row.detail}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rescans only what changed and picks up new routes", { timeout: 30000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "arch-explorer-"));
  try {
    writeFixture(root);
    const file = join(root, "src/Shop.Api/Program.cs");
    const scanner = new RepoScanner(root, { toolDir });
    const first = scanner.scan().snapshot;
    assert.equal(scanner.scan().changedFiles.length, 0, "nothing changed, nothing re-read");
    writeFileSync(file, `var app = builder.Build();\nvar api = app.MapGroup("/api");\napi.MapGet("/refunds", () => 1);\n`);
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    const after = scanner.scan();
    assert.deepEqual(after.changedFiles.map((c) => c.path), ["src/Shop.Api/Program.cs"]);
    assert.ok(after.snapshot.nodes["endpoint:GET /api/refunds"]);
    assert.equal(after.snapshot.nodes["endpoint:GET /api/orders"], undefined);
    assert.ok(after.snapshot.version > first.version);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

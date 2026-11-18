// Writes a small sample system (a shop) used by the tests: C# minimal APIs and a controller, authorization policies,
// Dapper SQL, SQL migrations, an xUnit test, and a React frontend with fetch, axios and an API client.
// Each file is tiny but uses a real pattern, so every scanner feature has something to find.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const FIXTURE_FILES = {
  "README.md": "# Shop\n\nA small shop: customers browse products, place orders and pay online.\n",
  ".architecture-explorer.json": JSON.stringify({ frontend: { permissionChecks: ["useCan"] }, workflow: { source: "docs/process.md", steps: [{ number: 1, keywords: ["product"] }, { number: 2, keywords: ["order"] }] } }, null, 2),
  "docs/process.md": "# Process\n\n| # | Step | Who |\n|---|---|---|\n| 1 | **Browse**: the customer looks at products | Customer |\n| 2 | **Order**: the customer places an order | Customer |\n| 3 | **Ship**: staff ship it | Staff |\n\nSee `src/Shop.Api/Program.cs` and `docs/missing.md`.\n",
  "Shop.sln": "",
  "src/Shop.Api/Shop.Api.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web">\n  <ItemGroup>\n    <ProjectReference Include="..\\Shop.Infrastructure\\Shop.Infrastructure.csproj" />\n  </ItemGroup>\n</Project>\n`,
  "src/Shop.Api/Program.cs": `using Shop.Infrastructure;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<OrderStore>();
builder.Services.AddSingleton<ProductStore>();
builder.Services.AddCors(o => o.AddPolicy("web", p => p.AllowAnyOrigin()));
builder.Services.AddAuthorization(options =>
{
    options.AddPolicy("Admin", p => p.RequireRole("Admin"));
});
var app = builder.Build();

var api = app.MapGroup("/api").RequireAuthorization();
api.MapGet("/orders", (OrderStore store) => store.ListAsync());
api.MapPost("/orders", CreateOrderAsync);
api.MapDelete("/orders/{id:int}", (int id, OrderStore store) => store.DeleteAsync(id)).RequireAuthorization("Admin");
app.MapGet("/health", () => "ok").AllowAnonymous();
// A payment webhook with no authorization at all.
app.MapPost("/webhooks/payment", (OrderStore store) => store.MarkPaidAsync());
app.MapControllers();
app.Run();

static Task<IResult> CreateOrderAsync(OrderRequest body, OrderStore store, HttpContext context)
{
    if (!context.User.IsInRole("Customer")) return Task.FromResult(Results.Forbid());
    return store.AddAsync(body);
}

public sealed record OrderRequest(int ProductId, int Quantity);
`,
  "src/Shop.Api/Controllers/ProductsController.cs": `using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Shop.Infrastructure;

namespace Shop.Api.Controllers;

/// <summary>Products: everyone signed in reads them, admins delete them.</summary>
[ApiController]
[Route("api/[controller]")]
[Authorize]
public sealed class ProductsController(ProductStore store) : ControllerBase
{
    [HttpGet]
    public Task<IActionResult> GetAll() => store.ListAsync();

    [HttpGet("{id:int}")]
    public Task<IActionResult> Get(int id) => store.GetAsync(id);

    [HttpGet("featured")]
    [AllowAnonymous]
    public Task<IActionResult> Featured() => store.FeaturedAsync();

    [HttpDelete("{id:int}")]
    [Authorize(Roles = "Admin")]
    public Task<IActionResult> Delete(int id) => store.DeleteAsync(id);
}
`,
  "src/Shop.Infrastructure/Shop.Infrastructure.csproj": `<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    <PackageReference Include="Dapper" Version="2.1.0" />\n    <PackageReference Include="Npgsql" Version="9.0.0" />\n    <PackageReference Include="Stripe.net" Version="45.0.0" />\n    <ProjectReference Include="..\\Shop.Domain\\Shop.Domain.csproj" />\n  </ItemGroup>\n</Project>\n`,
  "src/Shop.Infrastructure/OrderStore.cs": `using Dapper;
using Shop.Domain;

namespace Shop.Infrastructure;

/// <summary>Orders in the database.</summary>
public sealed class OrderStore
{
    private const string List = """
        SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id
        """;

    public Task<IResult> ListAsync() => Query(List);
    public Task<IResult> AddAsync(object body) => Query("INSERT INTO orders (customer_id, status) VALUES (@c, 'New')");
    public Task<IResult> DeleteAsync(int id) => Query("DELETE FROM order_lines WHERE order_id = @id");
    public Task<IResult> MarkPaidAsync() => Query($"UPDATE orders SET status = '{OrderStatus.Paid}' WHERE id = @id");
    private static Task<IResult> Query(string sql) => throw new NotImplementedException();
}
`,
  "src/Shop.Infrastructure/ProductStore.cs": `namespace Shop.Infrastructure;

/// <summary>Products, and the payment provider's address.</summary>
public sealed class ProductStore
{
    private const string Base = "https://api.stripe.com/v1";
    public Task<IActionResult> ListAsync() => Run("SELECT id, name FROM products");
    public Task<IActionResult> GetAsync(int id) => Run("SELECT * FROM products WHERE id = @id");
    public Task<IActionResult> FeaturedAsync() => Run("SELECT * FROM products WHERE featured");
    public Task<IActionResult> DeleteAsync(int id) => Run("DELETE FROM products WHERE id = @id");
    private static Task<IActionResult> Run(string sql) => throw new NotImplementedException();
}
`,
  "src/Shop.Domain/Shop.Domain.csproj": `<Project Sdk="Microsoft.NET.Sdk" />\n`,
  "src/Shop.Domain/Order.cs": `namespace Shop.Domain;

public enum OrderStatus { New, Paid, Shipped }

/// <summary>An order placed by a customer.</summary>
public sealed record Order(int Id, int CustomerId, OrderStatus Status);
`,
  "tests/Shop.Api.Tests/Shop.Api.Tests.csproj": `<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    <PackageReference Include="xunit" Version="2.9.0" />\n    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" />\n  </ItemGroup>\n</Project>\n`,
  "tests/Shop.Api.Tests/OrdersTests.cs": `namespace Shop.Api.Tests;

public class OrdersTests
{
    [Fact]
    public async Task Lists_orders() => await Client.GetAsync("/api/orders");

    [Theory]
    public void Rejects_bad_quantity(int q) { }
}
`,
  "db/migrations/001_init.sql": `CREATE TABLE customers (id serial PRIMARY KEY, name text NOT NULL);
CREATE TABLE products (id serial PRIMARY KEY, name text NOT NULL, featured boolean NOT NULL DEFAULT false);
CREATE TABLE orders (
    id serial PRIMARY KEY,
    customer_id int NOT NULL REFERENCES customers (id),
    status text NOT NULL
);
`,
  "db/migrations/002_lines.sql": `CREATE TABLE order_lines (
    order_id int NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    product_id int NOT NULL,
    quantity int NOT NULL,
    CONSTRAINT order_lines_product_fk FOREIGN KEY (product_id) REFERENCES products (id)
);
ALTER TABLE orders ADD COLUMN placed_at timestamptz;
`,
  "web/package.json": JSON.stringify({ name: "shop-web", private: true, dependencies: { react: "19.0.0", "react-dom": "19.0.0", "react-router-dom": "7.0.0", axios: "1.7.0" } }, null, 2),
  "web/tsconfig.json": `{\n  // comments are allowed here\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] }, "jsx": "react-jsx" }\n}\n`,
  "web/src/main.tsx": `import { createBrowserRouter } from "react-router-dom";
import { OrdersPage } from "@/features/orders/OrdersPage";
import { ProductsPage } from "./features/products/ProductsPage";

export const router = createBrowserRouter([
  { path: "/", element: <OrdersPage /> },
  { path: "/products", element: <ProductsPage /> },
]);
`,
  "web/src/lib/api.ts": `// The shared HTTP client.
export const api = { get: (url: string) => fetch(url), delete: (url: string) => fetch(url, { method: "DELETE" }) };
export function apiPost(path: string, body: unknown) {
  return fetch(path, { method: "POST", body: JSON.stringify(body) });
}
`,
  "web/src/features/orders/ordersApi.ts": `import axios from "axios";
import { apiPost } from "@/lib/api";

const BASE = "/api/orders";
export const listOrders = () => fetch(BASE);
export const placeOrder = (productId: number) => apiPost(BASE, { productId, quantity: 1 });
export const cancelOrder = (id: number) => axios.delete(\`\${BASE}/\${id}\`);
export const discounts = () => fetch("/api/discounts");
`,
  "web/src/features/orders/OrdersPage.tsx": `import { listOrders, placeOrder } from "./ordersApi";
import { useCan } from "@/lib/permissions";

export function OrdersPage() {
  const canDelete = useCan("Admin");
  void listOrders();
  void placeOrder(1);
  return <div>{canDelete ? "admin" : ""}</div>;
}
`,
  "web/src/lib/permissions.ts": `export function useCan(_permission: string): boolean {\n  return false;\n}\n`,
  "web/src/features/products/productsApi.ts": `import { api } from "@/lib/api";

export const product = (id: number) => api.get(\`/api/products/\${id}\`);
export const featured = () => api.get("/api/products/featured");
export const removeProduct = (id: number) => api.delete(\`/api/products/\${id}\`);
`,
  "web/src/features/products/ProductsPage.tsx": `import { featured } from "./productsApi";

export function ProductsPage() {
  void featured();
  return <div />;
}
`,
};

export function writeFixture(root) {
  for (const [path, text] of Object.entries(FIXTURE_FILES)) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return root;
}

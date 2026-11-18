# `.architecture-explorer.json`

An optional file at the repository root that tells the explorer about the project's own conventions. Every key is
optional; anything left out is auto-detected. The server rereads it on every change (and clears its cache, since it
changes how files are read). A different location can be passed with `--config <file>` to `server.mjs` or `cli.mjs`,
useful for trying a config without adding it to the repo.

## Contents

1. Full example
2. Keys
3. Finding a project's conventions
4. Checking the result

## 1. Full example

```json
{
  "name": "Shop",
  "description": "Customers browse products, place orders and pay online.",
  "ignore": ["legacy/", "samples/"],
  "layers": {
    "src/Shop.Gateway": "api",
    "src/Shop.Shared": "domain"
  },
  "backend": {
    "permissionEnum": "Permission",
    "roleEnum": "UserRole",
    "routeGuards": ["Requires", "RequiresOwnOr"],
    "requireChecks": ["Permissions.Require"],
    "allowsChecks": ["Permissions.Allows", "PermissionService.Has"]
  },
  "frontend": {
    "roots": ["web"],
    "apiFunctions": { "getJson": "GET", "postJson": "POST" },
    "apiClients": ["api", "http"],
    "permissionChecks": ["useCan", "hasPermission"],
    "screenFiles": ["AppShell.tsx"]
  },
  "database": { "migrations": ["db/migrations"] },
  "workflow": {
    "source": "docs/process.md",
    "steps": [
      { "number": 1, "keywords": ["product", "catalog"] },
      { "number": 2, "keywords": ["order", "cart"] },
      { "number": 3, "keywords": ["payment"], "note": "not built yet" }
    ]
  }
}
```

## 2. Keys

| Key | Default | What it does |
|---|---|---|
| `name`, `description` | README title and first paragraph | Title and summary on the Overview. |
| `ignore` | none (build output, `node_modules`, `bin`, `obj`, `.git` ... are always skipped) | Extra repo-relative folders or files to skip. |
| `layers` | from each `.csproj` name: `*.Api`/`*.Web`/`*.Server` → api, `*.Infrastructure`/`*.Data`/`*.Persistence` → infrastructure, `*.Domain`/`*.Core`/`*.Application` → domain, test projects → tests; otherwise Web SDK → api, else domain | Path prefix → layer (`api`, `infrastructure`, `domain`, `web`, `tests`, `docs`, `config`). The longest matching prefix wins. |
| `backend.permissionEnum` | none | A C# enum whose members are the app's permissions. Turns on permission nodes, references, the catalogue and the defaults table. |
| `backend.roleEnum` | none | A C# enum of roles. With a `Dictionary<PermissionEnum, RoleEnum[]>` in the code, each role's default permissions are drawn (named arrays and `..` spreads in the same file are resolved). |
| `backend.routeGuards` | none (`RequireAuthorization` is built in) | Extension methods called after `MapGet/MapPost/...` that take a permission: `.Requires(Permission.X)`. A `const Permission View = Permission.X;` alias is followed. |
| `backend.requireChecks` | none | Calls that enforce a permission inside handlers or business rules (`Permissions.Require(user, Permission.X)`). Followed from each handler through helpers, stores (by parameter type) and domain methods, four levels deep. |
| `backend.allowsChecks` | none (`IsInRole`, `AuthorizeAsync` are built in) | Calls that test a permission and branch (`if (!Permissions.Allows(...)) return Forbid()`). Shown as "branches on", not as a gate. |
| `frontend.roots` | every folder with a `package.json` that depends on a UI framework | Frontend app folders. Path aliases come from their `tsconfig.json` `paths` (and `@/` → `src/` if none). |
| `frontend.apiFunctions` | `fetch`, `axios`, `$fetch`, `useFetch`, and any `api*/http*/request*Get/Post/Put/Patch/Delete` | Extra function name → HTTP verb. Use `null` as the verb to read it from a `{ method }` argument. |
| `frontend.apiClients` | `axios, api, http, client, apiClient, httpClient, request, $http, ky` | Objects whose `.get/.post/.put/.patch/.delete(url)` are HTTP calls. |
| `frontend.permissionChecks` | none | Functions whose string argument is a permission the screen checks: `useCan("EditOrders")`. Matched to the server's permission or policy of the same name. |
| `frontend.screenFiles` | `Shell.tsx, Router.tsx, Routes.tsx, App.tsx` | File-name endings of switch-based routers (`case "orders": return <OrdersPage />`). React Router routes and Next.js `app/` / `pages/` are found anywhere. |
| `database.migrations` | every folder named `migrations` with `.sql` files | Folders replayed in file-name order into the final schema. |
| `workflow.source` | none | A Markdown file with the business process as a numbered table (`| 1 | **Name**: detail | Who |`) or list (`1. **Name** — detail`). |
| `workflow.steps` | none | Per step number, keywords that link the step to modules and routes whose names contain them. These links are always shown as inferred. `note` is shown on the step. |

## 3. Finding a project's conventions

Do this after the first scan, when the Security view shows many "sign-in only" addresses or no permissions at all.

- **Permission enum:** search for an enum used inside authorization code: `grep -rn "enum .*Permission" --include=*.cs`.
  Confirm it is used in guards or checks before naming it.
- **Route guards:** look at what follows `MapGet(`/`MapPost(` in endpoint files, e.g.
  `grep -rhoE "\)\s*\.\s*[A-Z]\w+\(" --include=*.cs | sort | uniq -c`. Custom names next to `RequireAuthorization`
  (such as `.Requires(` or `.RequirePermission(`) are the guards. Read the extension method to confirm it refuses
  the request without the permission.
- **Checks in code:** search handler and domain code for calls that take the permission enum:
  `grep -rn "Permission\.\w\+" --include=*.cs | grep -v "enum "`. A method that throws or returns 403 without the
  permission is a `requireChecks` entry; one that returns `bool` is an `allowsChecks` entry.
- **Screens:** `grep -rnE "use[A-Z]\w*\(\s*['\"]" web/src` and look for a hook or function that takes permission
  names.
- **Workflow:** ask the user whether a document describes their process. Don't invent one: the steps must come from
  a file in the repository.

Propose the config to the user with a one-line reason per key, and write it only once they agree.

## 4. Checking the result

Run `node <explorer>/cli.mjs --root <repo>` again and compare:

- The coverage row "Route guards" should now report the custom guards as understood (raw and matched equal).
- "N addresses that change data only check sign-in" should drop to the ones that really have no permission.
- If the project keeps a test with expected guard counts (`Dictionary<Permission, int>` in a test file), the
  "Cross-checks" section says whether the scan agrees with it, permission by permission.
- A config the explorer can't parse is reported as an important finding, and the defaults are used.

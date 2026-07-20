# Go Package View

VS Code extension that adds a virtual directory tree in the Explorer sidebar,
showing Go package dependency relationships starting from the main package.

---

## Architecture

```
extension.ts          ← activation, command registration, file watcher
  └─ treeProvider.ts  ← TreeDataProvider, renders tree nodes in Explorer
       └─ dataStore.ts ← session-level memory cache (Map<string, PackageInfo>)
            └─ goListRunner.ts ← runs `go list -json`, parses output
                 └─ types.ts, log.ts
```

### Data flow

1. Extension activates (`onView:goPackageView` event)
2. `loadAndRefresh()` → `dataStore.refresh(workspaceRoot)`
3. `findGoModDir()` walks up from workspace root looking for `go.mod`
4. `runGoList()` executes `go list -json -deps ./...` in the go.mod directory
5. Output is parsed by tracking `{`/`}` brace depth (handles multi-line JSON objects)
6. Parsed data stored in memory as `Map<string, GoPackageInfo>` + metadata
7. Mode detection: if any `Name === 'main'` package found → `normal` mode, else → `library` mode
8. `treeProvider.refresh()` fires `onDidChangeTreeData` → VS Code re-renders the view
9. `getChildren()` lazily builds child nodes from the memory cache

### Mode detection

| Condition | Mode | Tree direction | Root nodes |
|---|---|---|---|
| Module has `package main` | `normal` | Top-down via `Imports` | Main package(s) |
| No main package | `library` | Bottom-up via reverse deps | Packages with no internal deps |

### Tree node children rendering

Each package node expands to:
1. `.go` source files (sorted alphabetically, clickable to open editor)
2. Sub-packages (imports that are module-internal or third-party)

Stdlib was previously shown as a separate `stdlib` virtual folder per package,
but removed as it was deemed unhelpful. The `categorizeImports()` function still
classifies stdlib separately but the result is ignored by the tree provider.

### Icons

Custom SVG icons in `icons/`:
- `go-package.svg` — blue gradient folder, used for module-internal packages
- `go-package-external.svg` — orange gradient folder, used for third-party deps
- `go-file.svg` — document with blue top bar, used for `.go` files

Resolution: `vscode.Uri.joinPath(ICONS_DIR, name)` — `ICONS_DIR` is computed
from `__dirname` (resolves to `dist/../icons/`).

---

## Key files

### `src/goListRunner.ts`

Functions for interacting with the Go toolchain:

- `findGoModDir(startDir)` — walks up 20 levels looking for `go.mod`
- `extractModulePath(goModDir)` — parses `module` directive from `go.mod`
- `runGoList(goModDir, signal?)` — executes `go list -json -deps ./...`,
  parses output by tracking `{`/`}` depth (robust against multi-line JSON).
  Returns `ParsedData { modulePath, packages: Map, mainPkgs: GoPackageInfo[] }`.
- `isModuleInternal(importPath, modulePath)` — prefix check with nil guards
- `categorizeImports(info, allPkgs, modulePath)` — splits Imports into
  `{ stdlib, internal, external }` groups using `Standard` flag from go list
- `buildRevDeps(parsed)` — builds reverse dependency map for library mode
- `findLibraryRoots(parsed, revDeps)` — finds packages with no internal deps

### `src/dataStore.ts`

Session-level cache (`DataStore` class): holds `ParsedData` in memory.

- `refresh(workspaceRoot)` — runs go list, determines mode, builds rev deps
- `getRoots()` — returns `[{ label, importPath }]` for root level of tree
- `getChildrenOfPackage(importPath)` — returns `{ files, packageChildren }`
- `getPackageInfo(importPath)` — lookup in the parsed map
- `isInternal(importPath)` — checks if import path belongs to current module
- `shorten(importPath)` — strips module path prefix for display labels

Cancellation: a new `refresh()` call aborts the previous `go list` subprocess
via `AbortController`.

### `src/treeProvider.ts`

`GoPackageTreeProvider` implements `vscode.TreeDataProvider<ViewElement>`:

- `getTreeItem(element)` — creates `vscode.TreeItem` with icon, label, tooltip
- `getChildren(element?)` — dispatches to `getPackageChildren()` or returns roots
- `getPackageChildren(importPath)` — uses `dataStore.getChildrenOfPackage()`
  to build the child list: files → sub-packages

### `src/extension.ts`

Extension entry point. Registers:

- `goPackageView.openFile` — opens a .go file on click
- `goPackageView.refresh` — manually refresh the tree
- `goPackageView.copyImportPath` — copies import path to clipboard
- `goPackageView.openInTerminal` — opens terminal in package `Dir`
- `goPackageView.revealFileInOS` — reveals file in Finder/Explorer
- `goPackageView.newFile` — creates a new .go file (with `package` declaration)
- `goPackageView.newSubdirectory` — creates a subdirectory + init .go file
- `goPackageView.deleteFolder` — deletes package directory (with confirmation)

File watcher: monitors `go.mod`, `go.sum`, `*.go` changes with 300ms debounce.
Auto-refresh can be disabled via `goPackageView.autoRefresh` setting.

### `src/types.ts`

Type definitions:

- `GoPackageInfo` — corresponds to `go list -json` output fields
- `ParsedData` — the parsed result stored in memory cache
- `TreeMode` — `'normal' | 'library'`
- `ViewElement` — discriminated union for tree nodes (`package` or `file`)

### `src/log.ts`

Tiny logging wrapper — uses `console.log` with `[GoPkgView]` prefix.
Output appears in VS Code Developer Tools Console (`CMD+Shift+I`).

### `package.json` contributions

- `views.explorer` — registers the `goPackageView` view (appears as "Go Packages"
  section in the Explorer panel)
- `configuration` — settings like `autoRefresh`, `maxDepth`
- `commands` — all 8 commands listed above
- `menus.view/item/context` — right-click menu items, filtered by `viewItem`
  context value (`goPackage` or `goFile`)

---

## Build & run

```bash
npm install          # installs dependencies (typescript, esbuild, @types/vscode)
npm run build         # esbuild bundles src/extension.ts → dist/extension.js
npm run watch         # watch mode (auto-rebuild on changes)
```

### Debug in VS Code

Create `.vscode/launch.json`:
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/dist/**/*.js"]
    }
  ]
}
```

Press `F5` → Extension Development Host window opens → view appears in Explorer.

Logs: `CMD+Shift+I` → Console tab → filter by `[GoPkgView]`.

---

## Common issues

### "Nothing shows in the view"

1. Open Developer Tools Console to check `[GoPkgView]` logs
2. Check if `findGoModDir` found `go.mod` — it walks up from workspace root
3. Check if `go list -json -deps ./...` ran successfully (logs show `parsed N objects`)
4. If `mainPkgs` is empty, the mode switches to `library` — may need different root
5. If the view isn't requested (not clicked/expanded), `activate()` never runs
   (lazy activation via `onView:goPackageView`)

### "command not found" errors

Caused by commands declared in `package.json` but not registered via
`vscode.commands.registerCommand()` in `activate()`. Usually because:
- Extension activation threw an error (check Console)
- Commands are nested inside another callback (must be at top level of `activate()`)
- Extension host restarted but view wasn't re-activated

### `go list` takes too long

For large projects, `go list -json -deps ./...` can be slow (5-10s).
The data is cached in memory for the session, so it only runs once.
Refresh is debounced at 300ms to avoid repeated runs on file changes.

### Brace-depth JSON parser

`go list -json` output can be multi-line per package (e.g. long `Imports` arrays).
Splitting by `\n` and parsing each line independently would fail.
The parser tracks `{`/`}` brace depth to identify complete JSON object boundaries.

---

## Extension points for future improvement

### Pending features

- **Multiple main packages** — currently shows all found main packages as roots,
  but need to handle shared dependencies gracefully (avoid duplicate nodes)
- **Package search/filter** — `vscode.TreeView.message` for empty state,
  filter box above the tree to filter by package name
- **Focus mode** — auto-expand to show a specific package in context
- **`go.work` support** — detect workspace mode and handle multi-module projects
- **Depth limit** — `goPackageView.maxDepth` setting (already contributed but
  not implemented) to prevent expanding huge dependency trees

### Performance improvements

- **Disk cache for cold start** — cache `go list` output in
  `context.globalStoragePath` with `go.mod`+`go.sum` hash to avoid
  re-running on every VS Code startup
- **Incremental refresh** — only re-run `go list` when actual imports change
  (currently re-runs on any `.go` file change)

### UX improvements

- **Inline icons on tree items** — add `group: "inline"` to menu contributions
  for one-click access to common operations (terminal, copy)
- **Drag and drop** — support dragging a package node to the editor to open its
  main file, or into a terminal to CD to its directory
- **Go module docs** — show package documentation on hover (tooltip)
- **Mark dependencies as vendored vs downloaded** — different icon or badge

### Code quality

- **Unit tests** — `goListRunner.ts` functions can be tested with mock go list output
- **E2E tests** — use `@vscode/test-electron` with a test Go project fixture
- **Lazy tree building for large projects** — for projects with 500+ packages,
  consider building the tree on demand rather than expanding all children at once.
  Currently all children are returned from `getChildren()` which is fine for most
  projects but could be slow for `go-redis/v9` sized packages (60+ children).

### Build / distribution

- **Publish to marketplace** — requires a publisher account. Currently using
  publisher `codex` (not real). Update `publisher` in `package.json` before publishing.
- **CI pipeline** — GitHub Actions to run `npm run build` + type check on PRs
- **VSIX packaging** — `vsce package` to create `.vsix` for manual install

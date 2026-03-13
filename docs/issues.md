# vemora — Known Issues

---

## Legend

| Severity | Meaning |
|---|---|
| **critical** | Crash, data loss, or security breach in normal use |
| **high** | Incorrect behavior or significant performance regression |
| **medium** | Edge-case bug or noticeable slowdown |
| **low** | Minor UX inconsistency or theoretical edge case |

---

## SECURITY

### S1 · MEDIUM · `config.json` parsed without schema validation
**File:** `src/core/config.ts:124`

`JSON.parse(fs.readFileSync(...))` is cast directly to `AiMemoryConfig` without any validation. A malformed or adversarially crafted config (e.g. `exclude: null`) can cause runtime errors anywhere the config fields are accessed, with no informative error message.

**Fix:** add a minimal validation pass after parse (check required fields are present and of the right type).

---

### S2 · MEDIUM · TypeScript path alias resolution allows root escape
**File:** `src/indexer/deps.ts`

Aliases from `tsconfig.json` (`paths`) are applied via string substitution without canonicalization. An alias like `"@root": ["../../"]` would produce import paths that escape the project root, potentially causing those files to appear in the index or dependency graph.

**Fix:** normalize alias-resolved paths with `path.resolve()` and reject any that fall outside `rootDir`.

---

### S3 · LOW · Dynamic `require()` for optional deps creates implicit trust
**File:** `src/commands/index.ts:312–314`, `src/indexer/parser.ts`

`require("chokidar")` and `require("micromatch")` inside functions use Node's module resolution at runtime. If `node_modules` is writable by another process or if the npm lockfile is not enforced, a compromised package could inject code at the point of first use.

**Mitigation:** this is standard Node.js behavior, but worth noting for supply-chain awareness. Use `npm ci` (not `npm install`) in CI to pin exact versions.

---

## Summary

| # | Severity | Category | File |
|---|---|---|---|
| S1 | medium | security | `core/config.ts` |
| S2 | medium | security | `indexer/deps.ts` |
| S3 | low | security | `commands/index.ts` |

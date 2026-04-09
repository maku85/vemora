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
**File:** `src/core/config.ts:147`

`JSON.parse` is now wrapped in try/catch (syntax errors produce a friendly message), but the result is still cast directly to `AiMemoryConfig` with no field validation. A malformed config (e.g. `exclude: null`, missing `embedding.dimensions`) causes a runtime crash later with no informative error message pointing back to the config file.

**Fix:** add a minimal validation pass after parse (check required fields are present and of the right type).

---

---

### S3 · LOW · Dynamic `require()` for optional deps creates implicit trust
**File:** `src/commands/index.ts:312–314`, `src/indexer/parser.ts`

`require("chokidar")` and `require("micromatch")` inside functions use Node's module resolution at runtime. If `node_modules` is writable by another process or if the npm lockfile is not enforced, a compromised package could inject code at the point of first use.

**Mitigation:** this is standard Node.js behavior, but worth noting for supply-chain awareness. Use `npm ci` (not `npm install`) in CI to pin exact versions.

---

## PERFORMANCE

### P1 · LOW · `runSummarize` processes files sequentially
**File:** `src/commands/summarize.ts:116`

The `for` loop awaits each LLM call one at a time. Batching via `Promise.all` would only help with cloud providers (OpenAI, Anthropic) that support true parallel inference. For the default Ollama backend, requests are serialized server-side (single GPU), so client-side parallelism only adds queuing overhead with no throughput gain.

**Fix:** only relevant if a non-Ollama provider is configured. A `--concurrency` flag could enable it opt-in.

---

### P2 · MEDIUM · `saveFileSummaries` writes to disk on every file
**File:** `src/commands/summarize.ts:149`

The entire JSON index is serialized and written after every single LLM call. On a 100-file project this is 100 redundant disk writes. The intent (interrupt-resilience) is valid but can be achieved more cheaply.

**Fix:** accumulate results and save every N files (e.g. every 10) plus once at the end. Keep the per-file save only if `--resilient` is explicitly requested.

---

### P3 · LOW · `extractFileCalls` reads `newSymbols` while it is being populated
**File:** `src/commands/index.ts:232–239`

Inside a `Promise.all` batch, `Object.assign(newSymbols, fileSymbols)` (line 232) mutates the shared object before `extractFileCalls` reads it (line 238). Node.js is single-threaded so there is no true race, but files later in the same batch see symbols from earlier files in the batch, making call-graph results non-deterministic across re-runs with different batch orderings.

**Fix:** collect per-file symbols into a local map first, merge into `newSymbols` only after the full batch completes, then re-run `extractFileCalls` for the batch with the complete symbol set.

---

## Summary

| # | Severity | Category | File |
|---|---|---|---|
| S1 | medium | security | `core/config.ts` |
| S3 | low | security | `commands/index.ts` |
| P1 | high | performance | `commands/summarize.ts` |
| P2 | medium | performance | `commands/summarize.ts` |
| P3 | low | performance | `commands/index.ts` |

# ai-memory — Known Issues

Issue tracker interno. Ordinato per severità. Aggiornato: 2026-03-08.

---

## Legend

| Severity | Meaning |
|---|---|
| **critical** | Crash, data loss, or security breach in normal use |
| **high** | Incorrect behavior or significant performance regression |
| **medium** | Edge-case bug or noticeable slowdown |
| **low** | Minor UX inconsistency or theoretical edge case |

---

## BUG — Logic errors

### B1 · HIGH · Duplicate `IndexOptions` interface
**File:** `src/commands/index.ts:30–44`

The interface is declared twice — first without `watch`, then again with it. TypeScript merges the two declarations but the intent is unclear, and linters warn about it.

**Fix:** remove the first declaration and keep only the second (lines 37–44).

---

### B2 · HIGH · `options.query.slice()` without null check in `context.ts`
**File:** `src/commands/context.ts`

`ContextOptions.query` is typed as `string | undefined`. In the usage-tracking block, `options.query.slice(0, 120)` is called unconditionally, which throws `TypeError: Cannot read properties of undefined` when only `--file` is passed without `--query`.

**Fix:**
```typescript
query: options.query?.slice(0, 120),
```

---

### B3 · MEDIUM · BM25 cache hash does not detect mid-array mutations
**File:** `src/search/bm25.ts`

The cache-validity hash is built from chunk count + first chunk ID + last chunk ID. If a chunk in the middle of the array is added, removed, or replaced, the hash is unchanged and stale BM25 statistics are used, producing wrong rankings.

**Fix:** hash the full sorted list of chunk IDs, or derive the hash from the index metadata timestamp.

---

### B4 · MEDIUM · Jaccard fallback threshold mismatch in `deduplicateBySimilarity`
**File:** `src/search/merge.ts`

The Jaccard fallback fires with threshold `0.80`, but cosine deduplication uses `0.92`. Because Jaccard and cosine are not linearly comparable, the fallback is significantly more aggressive and will deduplicate chunks that cosine similarity would not. This causes context loss when embeddings are unavailable.

**Fix:** calibrate the Jaccard threshold separately (empirically `~0.65` gives comparable recall to cosine `0.92`), or document the intentional conservatism.

---

### B5 · MEDIUM · Single-line functions fall through to sliding-window chunker
**File:** `src/indexer/chunker.ts`

`hasBoundaries` is `true` only when at least one symbol has `endLine > startLine`. If all parsed symbols are single-line (e.g. arrow functions as object values), `hasBoundaries` is `false` and the file is split by the sliding window instead of by symbol boundaries.

**Fix:** treat `endLine === startLine` as a valid single-line symbol boundary rather than excluding it from the boundary check.

---

### B6 · LOW · Session expiration is sensitive to NTP clock skew
**File:** `src/storage/session.ts`

Expiry is checked as `Date.now() - new Date(lastActiveAt).getTime() > SESSION_TIMEOUT_MS`. If the system clock moves backward (NTP correction, DST, etc.), a live session could be considered expired and reset.

**Impact:** the active session's seen-chunk list is silently cleared; the next query re-sends all chunks the LLM has already seen.

---

### B7 · LOW · False-positive staleness warnings in `status` command
**File:** `src/commands/status.ts`

Knowledge-entry staleness is detected by comparing `fileEntry.lastModified` against `entry.createdAt`. If the file is `touch`-ed without content changes (e.g. by an editor or build tool), all associated knowledge entries are flagged as stale even though nothing semantic changed.

---

## PERFORMANCE

### P1 · HIGH · O(n) chunk lookup inside vector search loop
**File:** `src/search/vector.ts`

After HNSW returns result indices, `chunks.find((c) => c.id === chunkId)` is called for each result. `Array.find` is O(n) on the full chunk array. For topK=10 results and 5,000 chunks, this is 50,000 comparisons per query.

**Fix:**
```typescript
// Build once before search:
const chunkById = new Map(chunks.map(c => [c.id, c]));
// Then O(1) per lookup:
const chunk = chunkById.get(chunkId);
```

---

### P2 · HIGH · Hybrid search retrieves all chunks before filtering
**File:** `src/search/hybrid.ts`

`hybridSearch()` passes `chunks.length` as the topK to both `vectorSearch()` and `computeBM25Scores()`, materializing the full ranked list before merging and slicing to the actual topK. For a repo with 10,000 chunks, this allocates and sorts ~10,000 results per query.

**Fix:** pass `topK * 3` (or a similar oversampling factor) as the per-source limit, then merge and take topK.

---

### P3 · MEDIUM · O(n³) in `deduplicateBySimilarity` with large chunk arrays
**File:** `src/search/merge.ts`

`cache.chunkIds.indexOf(id)` is O(n) and is called inside a loop that is already O(n²). For a repo with thousands of chunks, this makes deduplication cubic.

**Fix:** build a `Map<id, index>` before the dedup loop:
```typescript
const idToIndex = new Map(cache.chunkIds.map((id, i) => [id, i]));
```

---

### P4 · MEDIUM · MMR does redundant `Array.from()` on every iteration
**File:** `src/search/mmr.ts`

In the inner MMR loop, vector extraction from the binary buffer is repeated for already-selected items on each iteration. The selected vectors should be cached after first extraction.

---

### P5 · MEDIUM · OpenAI embedding batch size is underutilized
**File:** `src/embeddings/openai.ts`

Batch size is hardcoded to 100. OpenAI's `text-embedding-3-small` supports up to 2,048 inputs per request. For an initial index of 2,000 chunks, this makes 20 sequential API calls instead of 1.

**Fix:** increase default batch size to `2048` (or make it configurable).

---

### P6 · LOW · Chat history splice is O(n) per message
**File:** `src/commands/chat.ts`

When history exceeds 10 messages, `history.splice(1, 2)` shifts the array. For long chat sessions, this adds O(n) work per turn. A ring-buffer or deque would be O(1).

**Impact:** negligible until sessions exceed ~1,000 messages, so low priority.

---

## SECURITY

### S1 · HIGH · Path traversal via `--file` argument
**File:** `src/commands/context.ts`

The `--file` path is resolved and validated against `rootDir`, but symlinks are followed by `fs.readFileSync` without resolution. A path like `--file ../../../etc/shadow` that resolves within `rootDir` via a symlink would be read and emitted verbatim in the context block.

**Fix:** resolve both the file path and `rootDir` with `fs.realpathSync` before comparing:
```typescript
const realRoot = fs.realpathSync(rootDir);
const realFile = fs.realpathSync(absFilePath);
if (!realFile.startsWith(realRoot + path.sep)) throw new Error("Path outside root");
```

---

### S2 · HIGH · API key selected by env var order, not by configured provider
**File:** `src/llm/factory.ts`

The factory checks `OPENAI_API_KEY` before `ANTHROPIC_API_KEY` regardless of which `provider` is configured. A developer who has both env vars set (common in polyglot environments) will silently use the OpenAI key even when the config specifies `anthropic`.

**Fix:** select the env var based on the configured provider:
```typescript
const apiKey = config.provider === "anthropic"
  ? process.env.ANTHROPIC_API_KEY ?? config.apiKey
  : process.env.OPENAI_API_KEY ?? config.apiKey;
```

---

### S3 · MEDIUM · `config.json` parsed without schema validation
**File:** `src/core/config.ts:124`

`JSON.parse(fs.readFileSync(...))` is cast directly to `AiMemoryConfig` without any validation. A malformed or adversarially crafted config (e.g. `exclude: null`) can cause runtime errors anywhere the config fields are accessed, with no informative error message.

**Fix:** add a minimal validation pass after parse (check required fields are present and of the right type).

---

### S4 · MEDIUM · Binary embedding file loaded without size check
**File:** `src/storage/cache.ts`

`fs.readFileSync(binPath)` loads the entire `embeddings.bin` into memory without checking file size first. A corrupted or intentionally oversized file could exhaust process memory.

**Fix:**
```typescript
const { size } = fs.statSync(binPath);
if (size > MAX_CACHE_BYTES) throw new Error(`Cache file too large: ${size} bytes`);
```

---

### S5 · MEDIUM · TypeScript path alias resolution allows root escape
**File:** `src/indexer/deps.ts`

Aliases from `tsconfig.json` (`paths`) are applied via string substitution without canonicalization. An alias like `"@root": ["../../"]` would produce import paths that escape the project root, potentially causing those files to appear in the index or dependency graph.

**Fix:** normalize alias-resolved paths with `path.resolve()` and reject any that fall outside `rootDir`.

---

### S6 · LOW · Dynamic `require()` for optional deps creates implicit trust
**File:** `src/commands/index.ts:312–314`, `src/indexer/parser.ts`

`require("chokidar")` and `require("micromatch")` inside functions use Node's module resolution at runtime. If `node_modules` is writable by another process or if the npm lockfile is not enforced, a compromised package could inject code at the point of first use.

**Mitigation:** this is standard Node.js behavior, but worth noting for supply-chain awareness. Use `npm ci` (not `npm install`) in CI to pin exact versions.

---

## Summary

| # | Severity | Category | File |
|---|---|---|---|
| B1 | high | bug | `commands/index.ts` |
| B2 | high | bug | `commands/context.ts` |
| B3 | medium | bug | `search/bm25.ts` |
| B4 | medium | bug | `search/merge.ts` |
| B5 | medium | bug | `indexer/chunker.ts` |
| B6 | low | bug | `storage/session.ts` |
| B7 | low | bug | `commands/status.ts` |
| P1 | high | performance | `search/vector.ts` |
| P2 | high | performance | `search/hybrid.ts` |
| P3 | medium | performance | `search/merge.ts` |
| P4 | medium | performance | `search/mmr.ts` |
| P5 | medium | performance | `embeddings/openai.ts` |
| P6 | low | performance | `commands/chat.ts` |
| S1 | high | security | `commands/context.ts` |
| S2 | high | security | `llm/factory.ts` |
| S3 | medium | security | `core/config.ts` |
| S4 | medium | security | `storage/cache.ts` |
| S5 | medium | security | `indexer/deps.ts` |
| S6 | low | security | `commands/index.ts` |

**Priorità immediata:** B2 (crash reale), S1 (path traversal), S2 (API key sbagliata), P1 e P2 (regressioni di performance evidenti in repo grandi).

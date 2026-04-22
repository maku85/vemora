# vemora — Planned Features

Features analyzed for implementation but deferred. Listed in ascending order of effort.

---

## Feature 2 — Coverage integration

**Effort:** high | **LLM value:** high (but conditional on tests existing)

### Goal

Show per-chunk test coverage in the file context block. Gives the LLM a signal for risk: uncovered code is more likely to contain undetected bugs.

```
Coverage:
- `runIndex` — 87% (lines 12–63)
- `performIndexIteration` — 42% ⚠ (lines 65–198)
- `startWatcher` — 0% ✗ (lines 200–240)
```

### Supported report formats

| Runner | Default output file | Format |
|---|---|---|
| Jest | `coverage/coverage-summary.json` | JSON (istanbul summary) |
| Vitest | `coverage/coverage-summary.json` | JSON (compatible with istanbul) |
| nyc / istanbul | `coverage/lcov.info` | LCOV |
| c8 | `coverage/lcov.info` | LCOV |

### Implementation sketch

```typescript
// src/indexer/coverage.ts

export interface FileCoverage {
  /** line number → covered (true) or not (false) */
  lines: Record<number, boolean>;
  /** 0–100 */
  pct: number;
}

export type CoverageIndex = Record<string, FileCoverage>; // relPath → coverage

/** Try to load a coverage report from well-known paths under rootDir. */
export function loadCoverageReport(rootDir: string): CoverageIndex | null {
  // 1. Try istanbul JSON summary
  // 2. Try lcov.info
  // Returns null if no report found → feature silently disabled
}

/** Compute coverage fraction for a chunk's line range. */
export function chunkCoverage(
  fileCov: FileCoverage,
  startLine: number,
  endLine: number,
): number {
  const lines = Array.from(
    { length: endLine - startLine + 1 },
    (_, i) => startLine + i,
  );
  const tracked = lines.filter((l) => l in fileCov.lines);
  if (tracked.length === 0) return -1; // no data
  const covered = tracked.filter((l) => fileCov.lines[l]).length;
  return Math.round((covered / tracked.length) * 100);
}
```

### Path mapping challenge

Coverage reports use absolute paths or repo-relative paths that may differ from the paths stored in the index. Resolution strategy (in order):

1. Exact match against `relPath`
2. Strip common prefixes (`/repo/`, `/workspace/`, `process.cwd() + "/"`)
3. Match on basename + directory suffix (last 2 path segments)

If no match found, skip coverage for that file silently.

### Integration points

1. **`src/indexer/coverage.ts`** — new file with `loadCoverageReport()` + `chunkCoverage()`
2. **`src/commands/context.ts`** — in the `--file` section, after complexity:
   - Call `loadCoverageReport(rootDir)` (cached per `runContext` call)
   - For each symbol/chunk in `allChunks` for `relFile`, compute `chunkCoverage()`
   - Render as a "Coverage:" block; show ⚠ if < 50%, ✗ if 0%
3. **`src/commands/status.ts`** — show overall project coverage if a report exists

### Coverage report location

The report path should be configurable in `config.json`:

```json
"coverage": {
  "reportPath": "coverage/coverage-summary.json"
}
```

Default: auto-detect from well-known paths. If not found, feature is silently skipped.

### Known risks

- **Staleness**: coverage reports are generated at test-run time, not at index time. The report may be stale (days old) by the time the LLM reads it. Show the report's `mtime` alongside coverage data.
- **Partial coverage**: not all files have test coverage tracked. Files excluded from coverage instrumentation will appear uncovered. Filter using the report's `excludes` list if available.
- **Multiple reports**: monorepos may have one report per package. The loader should optionally accept a glob pattern and merge results.

---

---

## Feature 3 — Decision metadata on `KnowledgeEntry`

**Effort:** low | **LLM value:** medium

### Goal

Extend `KnowledgeEntry` with optional decision-specific fields — without introducing a new storage file, new command, or separate data model. `vemora remember` with `category: decision` already covers the core use case; this adds the metadata that makes decisions more actionable in context.

### Extension to `KnowledgeEntry`

```typescript
// Addition to KnowledgeEntry in src/core/types.ts

export interface KnowledgeEntry {
  // … existing fields …

  /** Git SHA at the time the decision was made. */
  linkedCommit?: string;
  /** Project-relative file paths most affected by this decision. */
  relatedFiles?: string[];
  /** ID of the KnowledgeEntry this decision supersedes (if any). */
  supersedes?: string;
}
```

### CLI changes

Add optional flags to `vemora remember` (no new command needed):

```bash
vemora remember "Switched from REST to tRPC for end-to-end type safety" \
  --category decision \
  --commit HEAD \        # auto-resolve to current SHA
  --files src/api/,src/client/
```

`--commit HEAD` auto-resolves via `git rev-parse HEAD`. `--files` accepts a comma-separated list of paths.

### Context injection

`vemora context --file <path>` already injects `KnowledgeEntry` items. With `relatedFiles` populated, a filter can surface only entries relevant to the requested file:

```
Decisions affecting this file:
- [2026-03-10] Switched from REST to tRPC — (commit a1b2c3d)
```

### Integration points

1. **`src/core/types.ts`** — add `linkedCommit?`, `relatedFiles?`, `supersedes?` to `KnowledgeEntry`
2. **`src/commands/remember.ts`** — add `--commit`, `--files` flags; resolve `HEAD` via `git rev-parse`
3. **`src/commands/context.ts`** — when `--file` is set, prefer entries whose `relatedFiles` includes that path

### Known risks

- **Stale `relatedFiles`**: paths may be renamed or deleted. Check lazily during `context` and flag stale entries rather than silently injecting them.

---

---

## Feature 6 — MCP server mode

**Effort:** medium | **LLM value:** very high

### Goal

Expose vemora as a Model Context Protocol (MCP) server so that any MCP-compatible client (Claude Desktop, Cursor, Zed, Goose, …) can call `query`, `focus`, `context`, and `remember` as native tools — without going through the CLI. This turns vemora from a standalone CLI into shared RAG infrastructure usable by any agent.

### MCP tools to expose

| MCP tool | Maps to | Description |
|---|---|---|
| `vemora_query` | `vemora query` | Semantic search over the index |
| `vemora_focus` | `vemora focus` | Full context for a file or symbol |
| `vemora_context` | `vemora context` | Generate a context block for a task |
| `vemora_remember` | `vemora remember` | Persist a knowledge entry |
| `vemora_brief` | `vemora brief` | Return the session primer |

### Implementation sketch

```typescript
// src/commands/serve.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export async function runServe(rootDir: string): Promise<void> {
  const server = new McpServer({ name: "vemora", version: pkg.version });

  server.tool("vemora_query", { query: z.string(), keyword: z.boolean().optional() },
    async ({ query, keyword }) => {
      // call runQuery internals, return formatted results
    }
  );
  // … other tools …

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

CLI entry: `vemora serve --root .` (long-running process, speaks MCP over stdio).

### Integration points

1. **`src/commands/serve.ts`** — new file: MCP server setup + tool registrations
2. **`src/cli.ts`** — register `serve` subcommand
3. **`package.json`** — add `@modelcontextprotocol/sdk` dependency

### Known risks

- MCP SDK is still evolving; pin to a specific version.
- Each tool call re-loads index from disk unless a module-level cache is held in the server process. Add an in-memory cache of `RepositoryStorage` keyed by `rootDir`.

---

## Feature 7 — Prompt injection detection

**Effort:** low | **LLM value:** medium

### Goal

Detect and neutralise prompt injection attempts in indexed source files before their content is injected into LLM prompts. A malicious repo (or a supply-chain-compromised dependency) could embed strings like `// SYSTEM: ignore previous instructions` in comments or string literals that vemora would faithfully forward to the LLM.

### Detection strategy

Static pattern scan at chunk-injection time (no LLM round-trip needed):

```typescript
// src/utils/injection.ts

const INJECTION_PATTERNS = [
  /\bsystem\s*:/i,
  /ignore\s+(previous|prior|above)\s+instructions/i,
  /you\s+are\s+now\s+(?:a\s+)?(?:an?\s+)?\w+/i,
  /<\s*\/?(?:system|assistant|user)\s*>/i,
  /\[INST\]|\[\/INST\]/,              // Llama instruction markers
  /###\s*(?:System|Instruction)/i,
];

export function containsInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

export function sanitiseChunk(text: string): string {
  // Replace suspicious lines with a redaction marker rather than dropping them,
  // so the LLM still sees the file structure.
  return text
    .split("\n")
    .map((line) =>
      INJECTION_PATTERNS.some((re) => re.test(line))
        ? `/* [vemora: redacted potential prompt injection] */`
        : line,
    )
    .join("\n");
}
```

### Integration points

1. **`src/utils/injection.ts`** — new file: patterns + `sanitiseChunk()`
2. **`src/search/formatter.ts`** — call `sanitiseChunk()` on each chunk before formatting output
3. **`config.json`** — optional `"security": { "sanitiseInjections": true }` flag (default `true`)

### Known risks

- False positives on legitimate code that mentions system prompts (e.g. an LLM wrapper library). The redaction marker preserves file structure so the LLM can still reason about the file.
- Pattern list needs periodic updates as new injection techniques emerge. Keep it in a separate constant so it is easy to extend.

---

## Feature 8 — Recipes (reusable workflow YAML)

**Effort:** medium | **LLM value:** low–medium

### Goal

Allow users to define named, reusable workflows as YAML files that chain vemora commands. Example use cases: `security-audit`, `onboarding`, `changelog`. Reduces repetitive multi-command invocations.

```yaml
# .vemora/recipes/security-audit.yaml
name: security-audit
description: Run a full security triage and save findings to knowledge
steps:
  - run: triage --type security,bugs
    capture: findings
  - run: remember "Security triage findings: {{findings}}"
```

```bash
vemora recipe security-audit --root .
```

### Implementation sketch

```typescript
// src/commands/recipe.ts
interface RecipeStep {
  run: string;       // vemora subcommand + args (template variables allowed)
  capture?: string;  // variable name to capture stdout into
}
interface Recipe {
  name: string;
  description?: string;
  steps: RecipeStep[];
}
```

Steps are executed sequentially; `{{varName}}` interpolation passes output between steps.

### Integration points

1. **`src/commands/recipe.ts`** — new file: YAML loader + step runner
2. **`src/cli.ts`** — register `recipe <name>` subcommand
3. **`package.json`** — add `js-yaml` (or use Node 22 built-in YAML if available)

### Known risks

- Template interpolation is a potential injection vector if recipe files come from untrusted sources. Sanitise interpolated values or restrict recipes to the project's own `.vemora/` directory.
- Sequential execution only in v1; parallel steps (for independent queries) add complexity and can be deferred.

---

## Feature 9 — Knowledge injection in `context`

**Effort:** low | **LLM value:** high

### Goal

`focus` already injects relevant `KnowledgeEntry` items alongside retrieved code. `context` does not. Knowledge entries are token-dense (a few lines each) and carry non-obvious gotchas, design decisions, and patterns that would otherwise require the LLM to ask a follow-up query.

### Behaviour

After search results are formatted, append a "Knowledge" block containing entries whose `relatedFiles` or `relatedSymbols` overlap with the files present in the retrieved chunks. Cap at 5 entries, sorted by `createdAt` descending.

```
---
## Knowledge (2)

**Race condition in Promise.all batch** · pattern
Object.assign(newSymbols, fileSymbols) inside a Promise.all is not safe — concurrent writes produce partial symbol maps. Use per-file maps and merge serially after the batch resolves.

**Ollama serial inference** · pattern
Ollama processes LLM requests serially (single GPU). Parallelising summarise calls client-side saturates the queue — keep concurrency at 1.
```

### Integration points

1. **`src/commands/context.ts`** — after `formatMarkdown` / `formatTerse`, call `KnowledgeStorage.list()`, filter by file overlap (reuse the same `relatedKnowledge()` helper from `focus.ts`), append the block
2. **`src/commands/context.ts`** — add `--no-knowledge` flag to opt out
3. **`src/search/formatter.ts`** — add an optional `knowledgeBlock` parameter to `formatMarkdown` so the injection is cleanly separated from retrieval logic

### Known risks

- Knowledge entries are stored as free text; without `relatedFiles` populated they fall back to text-match heuristics, which can produce false positives on common words. Keep the same heuristic already used by `focus` to avoid introducing divergence.

---

---

## Feature 10 — Metadata deduplication in markdown formatter

**Effort:** low | **LLM value:** medium

### Goal

The markdown formatter prints `Imports:` and `Used by:` blocks for every result independently. When multiple results come from the same file, these blocks are identical and inflate the output with no information gain.

### Behaviour

Track `seen` file paths in the formatter loop. For any result after the first from the same file, skip the `Imports:` and `Used by:` blocks and replace them with a one-liner:

```
_Imports and usedBy already shown above (same file)._
```

For the `Call graph` (Calls/Called by) blocks, keep them per-symbol since they are symbol-specific even within the same file.

### Implementation sketch

```typescript
// in formatMarkdown()
const seenFileMeta = new Set<string>();

// inside the results loop:
if (!seenFileMeta.has(chunk.file)) {
  seenFileMeta.add(chunk.file);
  // render imports + usedBy blocks as today
} else {
  lines.push("_Imports and usedBy already shown above._");
  lines.push("");
}
```

### Integration points

1. **`src/search/formatter.ts`** — add `seenFileMeta` set to `formatMarkdown()`; same pattern for `formatJson()` (deduplicate at the JSON level by omitting `imports`/`usedBy` for duplicated files and adding a `"sameFileAs": rank` reference)

### Known risks

- A reader scanning only a single result block will miss the imports context. The "already shown above" line is sufficient to avoid confusion, but consider adding the rank number of the first occurrence for easy reference.

---

---

## Feature 11 — Lazy expansion (signature-first output)

**Effort:** medium | **LLM value:** high

### Goal

Most LLM queries only need to know *what* a symbol is (its signature and purpose), not its full implementation. Today, tier-"high" results always include up to `HIGH_CODE_LINES` lines of body. This is wasteful for exploration queries (`explain`, `refactor`, `add-feature`).

The idea: return only signatures by default and let the LLM request the full body explicitly via a second command.

### Behaviour

Add a `--signatures-only` flag to `context` and `query`. When set, all results are rendered at tier "med" regardless of their rank score — showing only the extracted signature. The output footer includes a prompt:

```
To expand a symbol: vemora expand <symbol> --root .
```

A new `vemora expand <symbol>` command retrieves the full chunk by exact symbol name from the index and prints its body, optionally with `--budget`.

### Implementation sketch

```typescript
// src/commands/expand.ts
export async function runExpand(target: string, rootDir: string, options: { budget?: number }): Promise<void> {
  const repo = new RepositoryStorage(rootDir);
  const chunks = repo.loadChunks();
  const match = chunks.find((c) => c.symbol === target);
  if (!match) { console.error(`Symbol not found: ${target}`); process.exit(1); }
  const out = truncateToTokenBudget(match.content, options.budget ?? 0);
  console.log(out.text);
}
```

### Integration points

1. **`src/commands/expand.ts`** — new file: exact-symbol lookup + body print
2. **`src/cli.ts`** — register `expand <target>` subcommand
3. **`src/commands/context.ts`** — add `--signatures-only` flag; when set, clamp all tiers to "med" before formatting
4. **`src/commands/query.ts`** — same `--signatures-only` flag

### Known risks

- `extractSignature` sometimes returns incomplete signatures for multi-line function heads or decorators. Review edge cases before shipping.
- The `expand` command needs a disambiguator when the same symbol name appears in multiple files. Add `--file` to scope the lookup.

---

---

## Feature 12 — Compressed plan step outputs

**Effort:** medium | **LLM value:** high

### Goal

In `plan`, `dependsOn` injects the full output of prior steps as context for subsequent steps. On long plans the accumulated context grows linearly and often repeats the same code blocks. Compressing each prior step's output to 3–5 bullet-point findings before injecting it reduces token usage by 50–80% on `analyze` steps.

### Behaviour

Add a `--compress-steps` flag to `plan`. When enabled, after each `analyze` step completes, the executor's output is summarised by the LLM into a compact findings block:

```
### Step 2 findings (compressed)
- `runContext` is the hot path; called by both `context.ts` and `ask.ts`
- `applyTokenBudget` is called after rerank, not before — order matters for quality
- No session deduplication applied when `--keyword` is set
```

The full step output is retained in `PlanSessionStorage` for auditability but only the compressed version is forwarded to dependent steps.

### Implementation sketch

```typescript
// in plan.ts, after executor returns for an analyze step:
if (options.compressSteps && step.action === "analyze") {
  const compressionPrompt = `Summarise the following analysis in 3-5 bullet points, preserving all actionable findings:\n\n${stepOutput}`;
  const compressed = await llm.complete(compressionPrompt, { maxTokens: 300 });
  session.steps[step.id].compressedOutput = compressed;
}
// inject compressed output instead of full output for dependsOn
```

### Integration points

1. **`src/commands/plan.ts`** — add `compressSteps` option; post-process analyze step outputs; use `compressedOutput` when building `dependsOn` context
2. **`src/storage/planSession.ts`** — extend `PlanStep` with optional `compressedOutput: string`
3. **`src/core/types.ts`** — extend `PlanSession` accordingly if needed

### Known risks

- Compression introduces an extra LLM round-trip per analyze step. Only worthwhile when `dependsOn` chains are long (≥ 3 steps). Consider auto-enabling only when a step has ≥ 2 dependents.
- The summarising LLM may drop a subtle but critical finding. Keep the full output accessible via `vemora plan --resume <id> --show-step <n>`.

---

---

## Feature 13 — Session query deduplication

**Effort:** medium | **LLM value:** medium

### Goal

When an LLM issues multiple semantically similar queries in the same session (common during iterative debugging), `context` re-retrieves and re-sends the same chunks. Session tracking (`--session`) already filters *seen chunks* but does not recognise that the new query is essentially the same as a prior one.

### Behaviour

On each `context` call with `--session`, compute the embedding of the incoming query and compare it against embeddings of prior session queries stored in `SessionStorage`. If cosine similarity ≥ 0.92, return only chunks that are *new* relative to the closest prior query, prepended with a header:

```
_Context update — 2 new chunks since last similar query ("how does hybrid search work?"):_
```

If all chunks were already seen, return a short note instead of repeating the full context.

### Implementation sketch

```typescript
// in runContext(), after embedding the query:
if (options.session) {
  const priorQueryEmbeddings = session.getQueryEmbeddings();
  const closest = priorQueryEmbeddings
    .map((e) => ({ emb: e, sim: cosineSimilarity(queryEmbedding, e.embedding) }))
    .sort((a, b) => b.sim - a.sim)[0];

  if (closest && closest.sim >= 0.92) {
    // filter to only chunks not seen in that prior query's result set
    results = results.filter((r) => !closest.emb.seenChunkIds.has(r.chunk.id));
    // prepend update header
  }
}
```

### Integration points

1. **`src/storage/session.ts`** — extend `SessionStorage` to store query embeddings and their result chunk IDs alongside seen chunk IDs
2. **`src/commands/context.ts`** — add deduplication check after embedding the query (only when `--session` is active)
3. **`src/search/vector.ts`** — `cosineSimilarity` is already exported; no changes needed

### Known risks

- Storing query embeddings increases session file size. Cap at the last 20 queries per session to bound memory.
- The 0.92 threshold is heuristic. Too high → no deduplication benefit. Too low → unrelated queries get filtered. Make it configurable via `config.json` with a sensible default.

---

---

## Feature 14 — `focus --depth 2` (two-hop graph traversal)

**Effort:** high | **LLM value:** high

### Goal

`focus` currently does one-hop traversal: direct deps and direct callers of the target. For debugging regressions and planning safe refactors, the LLM needs to see who calls the *callers* (blast radius), but today this requires manually chaining multiple `focus` or `usages` calls.

### Behaviour

Add `--depth 2` to `focus`. At depth 2, after collecting the 1-hop results, for each caller/dep found, collect their direct callers/deps in turn. All second-hop results are always rendered at tier "med" (signature only) to cap output size. The total output is bounded by `--budget`.

```
## Focus: runContext

### Implementation
…full body…

### Direct callers (depth 1)
- `src/commands/ask.ts` — runAsk [signature]
- `src/cli.ts` — inline call [signature]

### Indirect callers (depth 2)
- `src/commands/plan.ts` — runPlan calls runAsk [signature]
```

### Implementation sketch

```typescript
// in runFocus(), after 1-hop traversal:
if (options.depth2) {
  const secondHopCallers: string[] = [];
  for (const caller of firstHopCallerFiles) {
    const callerSymbolId = `${caller}:${callerSymbol}`;
    const callerInfo = callGraph[callerSymbolId];
    if (callerInfo) secondHopCallers.push(...callerInfo.calledBy);
  }
  // Deduplicate, exclude already-shown symbols, render at tier "med"
}
```

### Integration points

1. **`src/commands/focus.ts`** — extend `FocusOptions` with `depth?: 1 | 2`; add second-hop traversal loop with deduplication against first-hop results
2. **`src/cli.ts`** — add `--depth` flag to the `focus` subcommand (accepts `1` or `2`)
3. **`src/search/formatter.ts`** — no changes needed; second-hop results use existing tier-"med" rendering

### Known risks

- On highly connected modules (e.g. `config.ts`, `types.ts`) depth-2 can return hundreds of callers. Hard-cap second-hop results at 20 and note the truncation.
- Depth-2 traversal over the call graph is only meaningful when the call graph is complete. Files not parsed by tree-sitter (e.g. plain JS, `.vue`, `.svelte`) will have gaps. Flag this in the output when detected.

---

---

## Effort comparison

| Feature | New files | Modified files | External deps | Estimated effort |
|---|---|---|---|---|
| 2 — Coverage | `src/indexer/coverage.ts` | `types.ts`, `context.ts`, `status.ts` | none (LCOV parser is ~50 lines) | ~1–2 days |
| 3 — Decision metadata on KnowledgeEntry | none | `types.ts`, `remember.ts`, `context.ts` | none | ~2–3 h |
| 6 — MCP server | `src/commands/serve.ts` | `cli.ts`, `package.json` | `@modelcontextprotocol/sdk` | ~1–2 days |
| 7 — Prompt injection detection | `src/utils/injection.ts` | `formatter.ts` | none | ~2–4 h |
| 8 — Recipes | `src/commands/recipe.ts` | `cli.ts`, `package.json` | `js-yaml` | ~1 day |
| 9 — Knowledge injection in `context` | none | `context.ts`, `formatter.ts` | none | ~2–4 h |
| 10 — Metadata dedup in markdown | none | `formatter.ts` | none | ~1–2 h |
| 11 — Lazy expansion | `src/commands/expand.ts` | `cli.ts`, `context.ts`, `query.ts` | none | ~1 day |
| 12 — Compressed plan steps | none | `plan.ts`, `planSession.ts` | none | ~1 day |
| 13 — Session query dedup | none | `session.ts`, `context.ts` | none | ~1 day |
| 14 — `focus --depth 2` | none | `focus.ts`, `cli.ts` | none | ~1–2 days |

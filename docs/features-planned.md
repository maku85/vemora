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

## Feature 5 — Contradiction detection on `vemora remember`

**Effort:** medium | **LLM value:** high

### Goal

When saving a new knowledge entry, automatically check whether it contradicts an existing one. If a contradiction is detected, prompt the user to supersede the conflicting entry rather than creating a duplicate with conflicting claims.

Inspired by mempalace's `fact_checker.py`, adapted to use vemora's existing LLM infrastructure instead of a separate knowledge graph.

### Detection strategy

Two-pass approach:

1. **Fast pre-filter (no LLM)** — reuse the existing token-overlap similarity check in `runRemember`. If overlap > 0.4 with any existing entry, collect candidates.
2. **LLM contradiction check (optional)** — if candidates exist and an LLM is configured, ask it whether the new entry contradicts any candidate. This is the same single LLM call pattern already used for auto-classification.

```typescript
async function detectContradiction(
  newBody: string,
  candidates: KnowledgeEntry[],
  config: AiMemoryConfig,
): Promise<KnowledgeEntry | null> {
  if (!config.summarization && !config.planner) return null;
  const provider = createLLMProvider(config.summarization ?? config.planner!);
  const candidateList = candidates
    .map((c, i) => `[${i + 1}] (${c.id.slice(0, 8)}) ${c.title}: ${c.body.slice(0, 200)}`)
    .join("\n");
  const resp = await provider.chat([
    {
      role: "system",
      content:
        "You are a fact-checker for a software project knowledge base. " +
        "Given a new note and a list of existing notes, determine if the new note " +
        "DIRECTLY CONTRADICTS any existing note (i.e. they cannot both be true). " +
        "Reply with the number of the contradicting entry (e.g. '2'), or '0' if there is no contradiction.",
    },
    {
      role: "user",
      content: `New note: ${newBody}\n\nExisting notes:\n${candidateList}`,
    },
  ]);
  const idx = parseInt(resp.content.trim(), 10);
  if (isNaN(idx) || idx === 0 || idx > candidates.length) return null;
  return candidates[idx - 1] ?? null;
}
```

### UX flow in `runRemember`

```
$ vemora remember "We switched from REST to tRPC in March 2026" --root .

⚠  Possible contradiction with existing entry [a1b2c3d4] "REST API is the
   primary interface for all client communication" (decision, high confidence).

   New:      "We switched from REST to tRPC in March 2026"
   Existing: "REST API is the primary interface…"

   Options:
     [s] supersede the existing entry (recommended)
     [k] keep both entries
     [a] abort

Choice [s/k/a]:
```

If the command is run non-interactively (no TTY), the warning is printed but both entries are saved (safe default).

### Integration points

1. **`src/commands/remember.ts`** — add `detectContradiction()` call after similarity pre-filter; add interactive prompt using `readline` (stdlib, no new dep)
2. No new files needed.

### Known risks

- **False positives**: the LLM may flag updates to a fact as contradictions. The prompt should be tuned to distinguish "update" (same fact, new value) from "contradiction" (two mutually exclusive claims).
- **Latency**: adds one LLM round-trip to `vemora remember`. Only triggered when the pre-filter finds candidates, so no overhead on the common case.
- **Non-interactive use**: `--no-interactive` flag or TTY detection should bypass the prompt and default to keeping both entries.

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

## Effort comparison

| Feature | New files | Modified files | External deps | Estimated effort |
|---|---|---|---|---|
| 2 — Coverage | `src/indexer/coverage.ts` | `types.ts`, `context.ts`, `status.ts` | none (LCOV parser is ~50 lines) | ~1–2 days |
| 3 — Decision metadata on KnowledgeEntry | none | `types.ts`, `remember.ts`, `context.ts` | none | ~2–3 h |
| 5 — Contradiction detection | none | `remember.ts` | none (readline is stdlib) | ~4–6 h |
| 6 — MCP server | `src/commands/serve.ts` | `cli.ts`, `package.json` | `@modelcontextprotocol/sdk` | ~1–2 days |
| 7 — Prompt injection detection | `src/utils/injection.ts` | `formatter.ts` | none | ~2–4 h |
| 8 — Recipes | `src/commands/recipe.ts` | `cli.ts`, `package.json` | `js-yaml` | ~1 day |

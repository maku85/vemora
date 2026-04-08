# vemora — Planned Features

Features analyzed for implementation but deferred. Listed in ascending order of effort.

---

## Feature 1 — Complexity heuristics

**Effort:** medium | **LLM value:** medium

### Goal

Surface a complexity estimate for each symbol/chunk in the file context block. Helps the LLM prioritise attention (high-complexity functions are more likely to contain bugs and to benefit from careful reading).

### Metrics

| Metric | Source | Notes |
|---|---|---|
| Line count | `chunk.end - chunk.start` | Already available, trivial |
| Branch count | Regex on content | Count `if`, `else`, `for`, `while`, `switch`, `case`, `?`, `&&`, `\|\|`, `?.` |
| Nesting depth | tree-sitter (preferred) or indent heuristic | Indent heuristic fails on formatter-normalised code |

### Suggested thresholds (TypeScript / JavaScript)

```
lines > 40  OR  branches > 8  OR  depth > 4  →  "high"
lines > 20  OR  branches > 4  OR  depth > 3  →  "medium"
otherwise                                     →  "low"
```

Thresholds should be configurable in `config.json` under `display.complexity`.

### Implementation sketch

```typescript
// src/indexer/complexity.ts
export interface ComplexityMetrics {
  lines: number;
  branches: number;
  nestingDepth: number;
  level: "low" | "medium" | "high";
}

const BRANCH_RE = /\b(if|else|for|while|switch|case)\b|\?\.?|&&|\|\|/g;

export function computeComplexity(content: string): ComplexityMetrics {
  const lines = content.split("\n").length;
  const branches = (content.match(BRANCH_RE) ?? []).length;
  // nesting depth: count max run of leading spaces / indentSize
  const nestingDepth = Math.max(
    ...content.split("\n").map((l) => {
      const indent = l.match(/^( +)/)?.[1].length ?? 0;
      return Math.floor(indent / 2);
    }),
  );
  const level =
    lines > 40 || branches > 8 || nestingDepth > 4
      ? "high"
      : lines > 20 || branches > 4 || nestingDepth > 3
        ? "medium"
        : "low";
  return { lines, branches, nestingDepth, level };
}
```

### Integration points

1. **`src/indexer/complexity.ts`** — new file with `computeComplexity(content)`
2. **`src/core/types.ts`** — add optional `complexity?: ComplexityMetrics` to `Chunk`
3. **`src/commands/index.ts`** — compute and attach during chunking (or lazily in `context`)
4. **`src/commands/context.ts`** — render in file context after the file content block:

```
Complexity:
- `runIndex` — HIGH (52 lines, 11 branches, depth 5)
- `performIndexIteration` — MEDIUM (34 lines, 6 branches, depth 3)
```

5. **`src/commands/query.ts`** — optionally show complexity badge next to symbol name in results.

### Known risks

- Branch regex produces false positives in string literals and comments. A tree-sitter pass (already optional) would be more accurate but adds latency.
- "High complexity" is codebase-dependent. Thresholds that work for a utility library may be wrong for a transpiler. Consider per-project calibration via percentile (top 10% = high).

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

## Feature 3 — Temporal decision graph

**Effort:** high | **LLM value:** high

### Goal

Record architectural and design decisions as first-class entities linked to their git context, related files, and rationale. Enables the LLM to answer questions like *"why was X refactored?"* or *"what decision led to this pattern?"* by traversing a causal chain rather than relying on commit message text alone.

### Data model

```typescript
// src/storage/decisions.ts

export interface DecisionNode {
  id: string;              // UUID v4
  timestamp: string;       // ISO timestamp
  title: string;           // short label, e.g. "Switch from REST to tRPC"
  rationale: string;       // free-form explanation
  linkedCommit?: string;   // git SHA at the time of the decision
  relatedFiles?: string[]; // project-relative paths affected
  relatedSymbols?: string[];
  supersedes?: string;     // ID of the decision this replaces
  tags?: string[];         // e.g. ["architecture", "auth", "performance"]
}

export interface DecisionGraph {
  nodes: DecisionNode[];
  // edges are implicit: supersedes + shared relatedFiles/relatedSymbols
}
```

Persisted to `.vemora/decisions.json`.

### CLI surface

| Command | Behaviour |
|---|---|
| `vemora decide "<title>" --rationale "<text>"` | Create a new `DecisionNode`, auto-link to `HEAD` SHA and staged files |
| `vemora decisions list` | Print all nodes ordered by timestamp |
| `vemora decisions show <id>` | Full detail for one node |
| `vemora decisions forget <id>` | Remove a node |

The existing `remember` command (category `decision`) should become a thin alias for `decide`.

### Context injection

`vemora context --file <path>` already injects `KnowledgeEntry` items with `category: 'decision'`. With this feature, the context command should also inject `DecisionNode` entries whose `relatedFiles` include the requested file, formatted as:

```
Decisions affecting this file:
- [2026-03-10] Switch from REST to tRPC — "Chosen for end-to-end type safety; REST client
  was generating too many runtime type errors." (commit a1b2c3d)
```

### LLM-assisted capture

When running `vemora ask` or `vemora chat`, the LLM response may contain explicit design decisions. A post-response hook can prompt the user:

```
Detected a possible decision: "Use lazy initialisation for the HNSW index".
Save it? [y/N]
```

This keeps the graph growing organically without requiring manual `decide` calls.

### Implementation sketch

```typescript
// src/storage/decisions.ts
import { readJsonFile, writeJsonFile } from "./repository";

const DECISIONS_FILE = ".vemora/decisions.json";

export async function loadDecisions(rootDir: string): Promise<DecisionGraph> {
  return (await readJsonFile(rootDir, DECISIONS_FILE)) ?? { nodes: [] };
}

export async function saveDecision(
  rootDir: string,
  node: DecisionNode,
): Promise<void> {
  const graph = await loadDecisions(rootDir);
  graph.nodes.push(node);
  await writeJsonFile(rootDir, DECISIONS_FILE, graph);
}

export function decisionsForFile(
  graph: DecisionGraph,
  relPath: string,
): DecisionNode[] {
  return graph.nodes
    .filter((n) => n.relatedFiles?.includes(relPath))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
```

### Integration points

1. **`src/storage/decisions.ts`** — new file: load / save / query helpers
2. **`src/core/types.ts`** — add `DecisionNode` and `DecisionGraph` interfaces
3. **`src/commands/decide.ts`** — new command: create a node, auto-link to HEAD, resolve staged files via `git diff --cached --name-only`
4. **`src/commands/context.ts`** — inject `decisionsForFile()` results into the context block
5. **`src/cli.ts`** — register `decide` and `decisions` subcommands
6. **`src/utils/git.ts`** — add `getStagedFiles(rootDir): Promise<string[]>` helper

### Known risks

- **Manual upkeep burden**: if developers never run `vemora decide`, the graph stays empty. The LLM-assisted capture hook mitigates this but adds conversational friction.
- **Stale links**: a `relatedFiles` path may be renamed or deleted. Reference integrity should be checked lazily during `context` and stale entries flagged rather than silently dropped.
- **Scope creep**: a full graph with typed edge labels (e.g. `CAUSED_BY`, `SUPERSEDES`, `BLOCKED_BY`) is a significant undertaking. The initial implementation should use implicit edges only (shared files/symbols + `supersedes`) and introduce explicit edges only if query patterns demand them.

---

---

## Feature 4 — Temporal knowledge graph with validity windows

**Effort:** high | **LLM value:** high

### Goal

Extend the knowledge store so that facts about the project carry temporal validity: each entry records when it became true (`validFrom`) and, optionally, when it stopped being true (`validUntil`). This lets the LLM query the knowledge base *as of* a specific point in time and avoids surfacing stale facts.

Inspired by mempalace's `knowledge_graph.py`, adapted to vemora's TypeScript / JSON-file stack (no SQLite or Neo4j dependency).

### Data model extension

```typescript
// Addition to KnowledgeEntry in src/core/types.ts

export interface KnowledgeEntry {
  // … existing fields …

  /** ISO timestamp when this fact became true (defaults to createdAt). */
  validFrom?: string;
  /** ISO timestamp when this fact stopped being true. Absent = still valid. */
  validUntil?: string;
}
```

No new storage file is needed: the validity window is stored inline in `entries.json`.

### New CLI options

| Option | Command | Behaviour |
|---|---|---|
| `--as-of <date>` | `knowledge list` | Only show entries valid at the given ISO date |
| `--expired` | `knowledge list` | Only show entries with a `validUntil` in the past |
| `--invalidate <id>` | `knowledge forget` (or a new subcommand) | Set `validUntil = now` without deleting the entry |

### Context injection

`vemora context` and `vemora brief` should silently exclude entries whose `validUntil` is in the past. This prevents the LLM from acting on outdated facts without requiring manual cleanup.

### Implementation sketch

```typescript
// src/storage/knowledge.ts — add filter helper

export function filterValidAt(
  entries: KnowledgeEntry[],
  asOf: Date = new Date(),
): KnowledgeEntry[] {
  return entries.filter((e) => {
    if (e.validFrom && new Date(e.validFrom) > asOf) return false;
    if (e.validUntil && new Date(e.validUntil) <= asOf) return false;
    return true;
  });
}
```

### Integration points

1. **`src/core/types.ts`** — add `validFrom?` and `validUntil?` to `KnowledgeEntry`
2. **`src/storage/knowledge.ts`** — add `filterValidAt()` helper
3. **`src/commands/knowledge.ts`** — honour `--as-of` and `--expired` filters in `runKnowledgeList`; add `--invalidate <id>` to `runKnowledgeForget`
4. **`src/commands/context.ts`** — call `filterValidAt()` before injecting knowledge entries
5. **`src/commands/brief.ts`** — call `filterValidAt()` before rendering entries

### Known risks

- **Migration**: existing entries without `validFrom` / `validUntil` are treated as always-valid. No migration script needed.
- **Clock drift**: `validUntil` is set by the developer's local clock. Cross-timezone teams should use UTC consistently (ISO strings already are UTC by convention).

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

## Effort comparison

| Feature | New files | Modified files | External deps | Estimated effort |
|---|---|---|---|---|
| 1 — Complexity | `src/indexer/complexity.ts` | `types.ts`, `context.ts` (minor) | none | ~3–4 h |
| 2 — Coverage | `src/indexer/coverage.ts` | `types.ts`, `context.ts`, `status.ts` | none (LCOV parser is ~50 lines) | ~1–2 days |
| 3 — Temporal decision graph | `src/storage/decisions.ts`, `src/commands/decide.ts` | `types.ts`, `context.ts`, `cli.ts`, `utils/git.ts` | none | ~2–3 days |
| 4 — Temporal knowledge graph | none | `types.ts`, `knowledge.ts`, `context.ts`, `brief.ts`, `knowledge list` cmd | none | ~1 day |
| 5 — Contradiction detection | none | `remember.ts` | none (readline is stdlib) | ~4–6 h |

# ai-memory — Planned Features

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

## Effort comparison

| Feature | New files | Modified files | External deps | Estimated effort |
|---|---|---|---|---|
| 1 — Complexity | `src/indexer/complexity.ts` | `types.ts`, `context.ts` (minor) | none | ~3–4 h |
| 2 — Coverage | `src/indexer/coverage.ts` | `types.ts`, `context.ts`, `status.ts` | none (LCOV parser is ~50 lines) | ~1–2 days |

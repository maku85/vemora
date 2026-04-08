# vemora — Architecture

This document describes the system design, data flows, and key decisions behind `vemora`. It is intended for developers and LLM agents resuming work on the tool.

---

## Overview

`vemora` is a local RAG (Retrieval-Augmented Generation) system for code repositories. It pre-indexes a codebase into a structured format and enables semantic search over it, so that LLM tools receive only the relevant context rather than entire files.

The system solves a specific tension: **more context = better LLM understanding, but more tokens = higher cost and degraded focus**. The answer is precision retrieval.

---

## Three-layer architecture

```
┌─────────────────────────────────────────────────────┐
│  Layer 1: Repository Memory (git-versioned)          │
│                                                      │
│  .vemora/                                         │
│    config.json          project settings             │
│    metadata.json        index stats                  │
│    index/                                            │
│      files.json         file hashes + chunk IDs      │
│      chunks.json        code chunks                  │
│      symbols.json       symbol → location map        │
│      deps.json          intra-project import graph   │
│      callgraph.json     function call graph          │
│      todos.json         TODO/FIXME/HACK/XXX notes    │
│    summaries/                                        │
│      file-summaries.json  per-file AI descriptions   │
│      project-summary.json project-level overview     │
│    knowledge/                                        │
│      entries.json       LLM/human-authored notes     │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  Layer 2: Local Embedding Cache (NOT in git)         │
│                                                      │
│  ~/.vemora-cache/<projectId>/                     │
│    embeddings.json      { chunkId: number[] }        │
│    embeddings.bin       Float32Array vectors         │
│    embeddings.hnsw.json HNSW search index            │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  Layer 3: CLI Tool                                   │
│                                                      │
│  vemora init | index | query | context | deps | status │
│  vemora remember | knowledge list/forget | summarize   │
└─────────────────────────────────────────────────────┘
```

Layer 1 is committed to git so the whole team shares the same index without each developer rebuilding it. Layer 2 is local because embeddings are large binary data that doesn't belong in git (adds no diff value, large file churn).

There is also an implicit **session layer** managed by `storage/session.ts`, stored alongside the embedding cache in `~/.vemora-cache/<projectId>/session.json`. It tracks which chunks have already been returned to the LLM in the current session (30-minute idle TTL) to avoid repetition across sequential queries.

In full, the memory layers are:

| Layer | Location | Scope | TTL | Storage class |
|---|---|---|---|---|
| Session | `~/.vemora-cache/<id>/session.json` | single developer, single session | 30 min idle | `SessionStorage` |
| Local cache | `~/.vemora-cache/<id>/` | single developer, persistent | indefinite | `EmbeddingCacheStorage` |
| Project / team | `.vemora/` (git-versioned) | whole team, permanent | indefinite | `KnowledgeStorage`, `RepositoryStorage` |

### When to formalise this separation

The current implicit separation is sufficient. It should be made explicit (a shared `MemoryLayer` interface or a router that dispatches reads/writes by layer) only when one of the following triggers is reached:

1. **A global / cross-project layer is added** — e.g. user-level knowledge shared across all repositories. At that point a fourth layer exists and the routing logic becomes non-trivial.
2. **Feature 3 (temporal decision graph) is implemented** — decisions need a clear scope: is this decision session-scoped (ephemeral) or project-scoped (committed)? The layer boundary enforces that distinction.
3. **Context output labels layers** — if `vemora context` starts annotating each injected block with its origin (`[session]`, `[knowledge]`, `[index]`), a formalised layer model makes the rendering logic cleaner.

---

## Data flow: `vemora index`

```
Filesystem
    │
    ▼ fast-glob
[ScannedFile[]]   relativePath, absolutePath, extension
    │
    ▼ SHA-256 hash per file
[Changed files]   files whose hash differs from files.json
    │
    ├── Unchanged files → carry forward from previous index
    │
    ▼ fs.readFileSync (changed files only)
[file content]
    │
    ├──▶ parseSymbols()     tree-sitter (TS/JS) or regex fallback
    │       └─▶ ParsedSymbol[]   name, type, startLine, endLine, exported
    │
    ├──▶ chunkFile()        symbol-boundary or sliding-window chunking
    │       └─▶ Chunk[]         id, file, start, end, symbol, content
    │
    ├──▶ buildSymbolIndex() ParsedSymbol[] → SymbolIndex (map)
    │
    ├──▶ extractFileImports()  regex-based import parsing
    │       └─▶ ImportEntry[]  resolved intra-project imports with symbols
    │
    ├──▶ extractTodos()        regex scan for TODO/FIXME/HACK/XXX comments
    │       └─▶ TodoAnnotation[]  file, line (1-based), type, text
    │
    └──▶ extractFileCalls()    tree-sitter call expression extraction
            └─▶ CallGraph[]    local calls and callees per file

    ▼ updateDependencyGraph() + buildGlobalCallGraph()
[Graphs]   incremental merge with previous state
    │
    ▼ saveFiles() + saveChunks() + saveSymbols() + saveDeps() + saveCallGraph() + saveTodos()
[.vemora/index/]
    │
    ▼ EmbeddingProvider.embed()   batched, only new chunks
[number[][]]   one vector per chunk
    │
    ▼ EmbeddingCacheStorage.update() + prune()
[~/.vemora-cache/<id>/embeddings.bin]
    │
    ▼ rebuildHNSWIndex()
[~/.vemora-cache/<id>/embeddings.hnsw.json]
```

---

## Data flow: `vemora query`

```
User query string
    │
    ▼ EmbeddingProvider.embed([question])
[queryEmbedding: number[]]
    │
    ├── If embeddings unavailable → computeBM25Scores()
    │
    ▼ hybridSearch() (Default in chat, optional in query/context)
        ├─▶ vectorSearch() (HNSW or exhaustive)
        └─▶ computeBM25Scores() (Keyword precision)
[SearchResult[]]   { chunk, score, symbol }  sorted by alpha-weighted sum
    │
    ▼ (optional) rerankResults()        cross-encoder re-scoring
    │
    ▼ (optional) applyMMR()             diversity-aware deduplication
    │
    ▼ (optional) mergeAdjacentChunks()  collapse adjacent/overlapping chunks
    │
    ▼ (optional) applyTokenBudget()     cap total tokens
    │
    ▼ computeImportedBy(depGraph)   reverse edge map
    │
    ├── (default) Flat ranked output per result:
    │       - file + symbol + line range + score
    │       - imports[] from depGraph[file]
    │       - usedBy[] from importedByMap.get(file)
    │       - calls[] from callGraph[symbolId]
    │       - calledBy[] from callGraph[symbolId]
    │       - optional: code snippet (--show-code)
    │
    └── (--structured) Semantic sections output:
            ## Entry Point         top chunk, full code
            ## Direct Dependencies signatures of depth-1 callees (call graph)
            ## Called By           caller IDs (contract context)
            ## Types & Interfaces  interface/type chunks from result set
            ## Related Patterns    remaining chunks, signatures only
```

---

## Data flow: `vemora remember` / knowledge store

The knowledge store is a human- and LLM-writable layer that captures information the structural index cannot: architectural decisions, approved patterns, recurring gotchas, domain glossary.

```
vemora remember "<text>" [--category gotcha|pattern|decision|glossary]
                             [--title "…"] [--files src/…] [--symbols …]
    │
    ▼ Validation (min 20 chars)
    │
    ▼ Duplicate detection
        computeBM25 overlap of body against existing entries
        warn if any existing entry has > 60% term overlap
    │
    ▼ KnowledgeStorage.add(entry)
[.vemora/knowledge/entries.json]   committed to git, shared with team
```

### Integration into `vemora context`

When `context` runs (flat or `--structured`), a `## Knowledge` section is prepended:

```
rankKnowledgeEntries(query, searchResults, entries, maxEntries=5)
    │
    ├─ +10 pts  relatedFiles overlap with result files
    ├─ +8 pts   relatedSymbols overlap with result symbols
    ├─ +2/term  query term appears in entry body
    ├─ +4/3/2/1 category weight (gotcha > pattern > decision > glossary)
    └─ +1 pt    confidence = high
    │
    ▼ top 5 entries included as ## Knowledge section
```

Entries that score only on category weight (no query/file/symbol match) are filtered out to avoid noise.

### Staleness detection in `vemora status`

```
For each knowledge entry with relatedFiles:
    if entry has relatedFileHashes[file]:
        fileIndex[file].hash !== relatedFileHashes[file]   ← content-based (immune to touch)
    else (legacy entry without hash snapshot):
        fileIndex[file].lastModified > entry.createdAt     ← timestamp fallback
    → print ⚠ warning with entry title and creation date
```

New entries created by `vemora remember --files ...` store a SHA-256 hash snapshot of each related file at creation time (`relatedFileHashes` field in `KnowledgeEntry`). Staleness is then detected by hash comparison, not timestamp, so a `touch` or editor save without content changes no longer triggers a false-positive warning.

---

## Git history context (`vemora context --file`)

When `--file` is used, `context` calls `getFileGitHistory(rootDir, relPath)` on-demand via `git log --follow`. This is not stored in the index — git is the authoritative source. The last 5 commits that touched the file are appended to the file context block, giving the LLM "why was this changed" information without requiring any additional indexing.

```
getFileGitHistory(rootDir, relPath, maxCommits=5)
    │
    ▼ spawnSync("git", ["log", "--follow", "--format=%H\x1f%s\x1f%an\x1f%ai", "--", relPath])
[GitCommit[]]   { sha (8 chars), message, author, date (YYYY-MM-DD) }
    │
    ▼ appended to file context section after imports/used-by
```

---

## TODO/FIXME annotation index

`extractTodos()` scans each changed file during `vemora index` for `TODO`, `FIXME`, `HACK`, and `XXX` markers (case-insensitive). Results are stored in `.vemora/index/todos.json` (versioned in git, shared with the team).

**Incremental:** unchanged files carry their existing annotations forward; only changed files are re-scanned.

**Exposed in two places:**
- `vemora context --file <path>`: TODOs in that file are shown in the context block
- `vemora status`: total count and per-type breakdown

---

## Test file linkage (`vemora context --file`)

When `--file` is used, `context` discovers test files related to the source file using `findTestFiles()`. No separate index is needed — results are derived at query time from the existing chunk corpus.

Two complementary strategies are applied and deduplicated:

```
findTestFiles(relPath, allFiles, importedBy?)
    │
    ├── Strategy 1a: sibling test files
    │       e.g. src/foo.ts → src/foo.test.ts, src/foo.spec.tsx
    │
    ├── Strategy 1b: same stem inside adjacent test directories
    │       e.g. src/__tests__/foo.test.ts, test/foo.test.ts, __tests__/foo.ts
    │
    └── Strategy 2: import-based
            any file that imports relPath AND whose path contains "test" or "spec"
            (uses the reversed importedBy map from computeImportedBy)
    │
    ▼ deduplicated Set → sorted string[]
```

This is a **pure derivation** — no test linkage data is stored in the index. This avoids staleness issues with incremental indexing: the list is always accurate for the current set of indexed files.

---

## Caller context (`vemora context --file`)

After test linkage, the file context block shows which symbols in the file are called by other symbols, grouped by exporting symbol. This is derived from the existing `callgraph.json` index.

```
For each symbol S in allChunks where chunk.file === relFile:
    callGraph["${relFile}:${S}"].calledBy → list of callerIds
    │
    ▼ rendered as:
      Symbol callers:
      - `S` ← `src/commands/context.ts:runContext`, `src/cli.ts:main` [+N more]
```

Only symbols that actually appear in `calledBy` are shown. The display is capped at 5 callers per symbol with an overflow count.

---

## Chunking strategy

Chunks are the fundamental unit of both storage and retrieval. The chunker has two modes:

### Symbol-boundary chunking (preferred)

Used when tree-sitter successfully parses the file and returns symbols with real line ranges (`endLine > startLine`).

1. Extract top-level symbol boundaries
2. Include a "header" chunk (imports + top-level declarations) before the first symbol
3. One chunk per symbol
4. If a symbol exceeds `maxChunkLines` or `maxChunkChars`, split it further with sliding window
5. Trailing content after the last symbol gets its own chunk

This produces semantically coherent chunks that map to actual functions and classes.

### Sliding-window chunking (fallback)

Used for non-TS/JS files, regex-parsed files, or oversized symbols.

- Window size: `maxChunkLines` (default: 80)
- Overlap: 10% of window size (preserves context at boundaries)
- Applied recursively for oversized symbols

### Chunk IDs

```typescript
id = sha256(filePath + '\n' + content).slice(0, 16)
```

Content-based, not position-based. If the code inside a function doesn't change, the chunk ID is stable across branches and rebases, allowing embedding cache reuse without API calls.

---

## Dependency graph

### What is tracked

Only **intra-project relative imports** are tracked. npm packages and Node built-ins are ignored.

Tracked:
- `import { A } from './path'` → named imports with symbol list
- `import A from './path'` → default import
- `export { A } from './path'` → re-exports
- `import('./path')` / `require('./path')` → dynamic imports

Not tracked:
- `import React from 'react'` (npm)
- `import fs from 'fs'` (Node built-in)

### Path resolution

The resolver tries (in order):
1. Exact path as-is
2. Path + `.ts`, `.tsx`, `.js`, `.jsx`
3. Path as directory + `/index.ts`, `/index.tsx`, `/index.js`
4. `.js` → `.ts` swap (for TypeScript projects that write `import './foo.js'`)

### Storage format

```json
{
  "src/imap/client.ts": {
    "imports": [
      { "file": "src/core/types.ts", "symbols": ["Credentials", "Connection"] }
    ]
  }
}
```

The **reverse graph** (importedBy) is not stored — it's derived at query time by inverting this forward graph. This avoids redundancy and keeps `deps.json` smaller.

### Incremental update

- Changed/new files: re-extract imports from content (already read during chunking)
- Unchanged files: carry forward existing entry from previous `deps.json`
- Deleted files: remove entry

---

## Call Graph analysis

The `callgraph.json` file tracks function-to-function calls within the project.

### Extraction

Using tree-sitter, we identify `call_expression` nodes:
1. Resolve the function name being called.
2. Link it to the current scope (e.g., `src/main.ts:runApp`).
3. Store the relation: `SourceSymbol → TargetSymbol`.

### Storage format

```json
{
  "src/main.ts:runApp": {
    "calls": [
      { "name": "initDB", "file": "src/db.ts" },
      { "name": "startServer", "file": "src/server.ts" }
    ],
    "calledBy": ["src/index.ts:main"]
  }
}
```

The graph is bidirectional; every time a call is identified, both the caller's `calls` list and the callee's `calledBy` list are updated.

## Symbol extraction

### tree-sitter (primary, JS/TS only)

Extracts with exact line ranges:
- `function_declaration` → function
- `arrow_function` in `variable_declarator` → function
- `class_declaration` → class (recursively extracts methods)
- `method_definition` → method (linked to parent class)
- `interface_declaration` → interface
- `type_alias_declaration` → type
- `export_statement` → sets `exported: true` on wrapped declaration

### Regex fallback (all other files)

Matches common patterns for TypeScript, JavaScript, Python, Rust, Go. Returns `endLine === startLine` (single-line match), so the chunker cannot use symbol boundaries and falls back to sliding window.

---

## Embedding providers

The `EmbeddingProvider` interface:

```typescript
interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}
```

Implementations: `OpenAIEmbeddingProvider`, `OllamaEmbeddingProvider`, `NoopEmbeddingProvider`.

Selected via `createEmbeddingProvider(config.embedding)` in `src/embeddings/factory.ts`.

Chunks are embedded with a prefix that encodes location metadata:
```
file: src/imap/client.ts
symbol: connect

<raw code content>
```

This improves retrieval because the embedding captures both what the code does *and* where it lives.

---

## Vector search

### HNSW Acceleration

The system uses HNSW (Hierarchical Navigable Small World) graph search to scale to very large repositories.
- **Complexity**: O(log N) for search.
- **Library**: `hnsw` package (pure JS/TS).
- **Fallback**: If the HNSW index is missing or fails, the search falls back to a highly optimized exhaustive binary search using `Float32Array` buffers.

### Keyword search (fallback)

Term frequency scoring:
```
score += occurrenceCount / log(contentLength)
```

Bonus ×1.5 if the query term appears in the symbol name; ×2 for exact symbol match. Used when:
- No embeddings are cached
- Provider is `none`
- `--keyword` flag is passed

---

## Incremental indexing guarantee

The system guarantees **correctness under incremental updates**:

| Event | Action |
|---|---|
| File unchanged | Hash matches → carry forward all data |
| File changed | Re-parse, re-chunk, re-embed |
| File deleted | Remove from files, chunks, symbols, deps |
| New file | Parse, chunk, embed |

Edge case: if a file is renamed (deleted + new path), files that imported the old path will have stale dep entries until they are also modified. This resolves naturally the next time those files change.

---

## Git strategy

Files in `.vemora/index/` are plain JSON, intentionally human-readable and diff-friendly:

- `files.json` — compact object, diffs show added/removed/changed files
- `chunks.json` — array, diffs show added/removed chunks
- `symbols.json` — compact object, diffs show symbol additions/removals
- `deps.json` — compact object, diffs show import changes

This makes code review of index updates meaningful: reviewers can see which new symbols were introduced, which files gained/lost dependencies, etc.

---

## Key design decisions

| Decision | Rationale |
|---|---|
| CommonJS (not ESM) | Simpler interop with tree-sitter native bindings and older Node APIs |
| Binary + JSON embedding cache | Metadata in JSON (inspectable); vectors in `Float32Array` binary (performance). No extra DB dependency. |
| Content-hash chunk IDs | Enables cross-branch embedding reuse |
| Reverse dep graph computed at runtime | Avoids redundant storage; forward graph is the source of truth |
| tree-sitter in `optionalDependencies` | Regex fallback ensures the tool works even without native build |
| `openai` and `@anthropic-ai/sdk` in `optionalDependencies` | Users install only the SDK for the provider they actually use; a clear error is thrown at instantiation time if the package is missing |
| Embeddings prefixed with metadata | Better retrieval quality (embedding knows file + symbol context) |
| No session memory / conversation state | Out of scope; intended to be used as a pre-query tool |
| Adjacent chunk merge as opt-in post-step | Keeps chunks atomic in the index; merging at retrieval time avoids duplicating content only when it's actually needed for display |
| Structured context (`--structured`) as opt-in | Default flat list is simpler and composable; structured layout is opt-in so bench and programmatic callers are unaffected. Structured mode reduces tokens ~20-35% and makes relationships explicit for LLMs. |
| Knowledge store in git, not in embedding cache | Entries are text-only, human-readable, diff-friendly. They live in Layer 1 (git) so the whole team shares them. No embeddings needed — lightweight BM25 term overlap is sufficient for the small corpus of entries. |
| Knowledge ranking is additive, not exclusive | Entries score points for file/symbol/query overlap; pure category-weight-only matches are filtered. This prevents low-relevance entries from polluting context when unrelated. |

# vemora — Codebase Reference

Complete file-by-file breakdown of the `vemora/` package. This document is optimized for LLM consumption: an agent reading it should be able to resume work on any part of the codebase without first scanning all the source files.

---

## Project root

| File | Purpose |
|---|---|
| `package.json` | npm manifest. `bin.vemora` → `./dist/cli.js`. Key deps: commander, fast-glob, chalk, ora, openai. tree-sitter in `optionalDependencies`. |
| `tsconfig.json` | TypeScript config. `module: commonjs`, `target: ES2022`, `strict: true`, `esModuleInterop: true`. Out: `./dist/`. |
| `.gitignore` | Ignores `node_modules/`, `dist/`, map files. |
| `README.md` | User-facing documentation. |
| `docs/` | Developer and LLM documentation. |

---

## `src/cli.ts` — CLI entry point

The Commander.js program definition. Registers fourteen commands (plus one subcommand group):

| Command | Handler |
|---|---|
| `init` | `commands/init.ts:runInit` |
| `init-claude` | `commands/init-claude.ts:runInitClaude` |
| `init-agent` | `commands/init-agent.ts:runInitAgent` |
| `index` | `commands/index.ts:runIndex` |
| `query <question>` | `commands/query.ts:runQuery` |
| `ask <question>` | `commands/ask.ts:runAsk` |
| `context` | `commands/context.ts:runContext` |
| `deps <file>` | `commands/deps.ts:runDeps` |
| `status` | `commands/status.ts:runStatus` |
| `summarize` | `commands/summarize.ts:runSummarize` |
| `chat` | `commands/chat.ts:runChat` |
| `bench <query>` | `commands/bench.ts:runBench` |
| `overview` | `commands/overview.ts:runOverview` |
| `remember <text>` | `commands/remember.ts:runRemember` |
| `brief` | `commands/brief.ts:runBrief` |
| `knowledge list` | `commands/knowledge.ts:runKnowledgeList` |
| `knowledge forget <id>` | `commands/knowledge.ts:runKnowledgeForget` |

All commands accept `--root <dir>` (defaults to `process.cwd()`). Errors are caught and printed with `chalk.red`, then `process.exit(1)`.

Commands are implemented in separate files in `src/commands/` to keep the entry point clean and maintainable.

---

## `src/core/types.ts` — All TypeScript types

Single source of truth for the data model. No runtime code.

### Key interfaces

**`AiMemoryConfig`** — loaded from `.vemora/config.json`
- `projectId`: deterministic hash of rootDir path
- `rootDir`: injected at load time, NOT persisted (so the project can be moved)
- `include`/`exclude`: fast-glob patterns
- `maxChunkLines`, `maxChunkChars`: chunking limits
- `embedding`: `EmbeddingConfig` (provider, model, dimensions, apiKey, baseUrl)

**`FileIndex`** (`files.json`) — `{ [relativePath]: FileEntry }`
- `FileEntry`: hash, size, lastModified, chunk IDs[], symbol names[]

**`Chunk`** (`chunks.json`) — array
- `id`: content-hash (16 hex chars)
- `file`: relative path
- `start`/`end`: 1-based line numbers (inclusive)
- `symbol`: name of the containing symbol (optional)
- `content`: raw source text

**`SymbolIndex`** (`symbols.json`) — `{ [name]: SymbolEntry }`
- `SymbolEntry`: type, file, startLine, endLine, exported, parent (for methods)

**`DependencyGraph`** (`deps.json`) — `{ [relativePath]: FileDependencies }`
- `FileDependencies.imports`: `ImportEntry[]`
- `ImportEntry`: resolved file path + named symbols imported

**`Metadata`** (`metadata.json`) — index statistics
- lastIndexed, indexedFiles, totalChunks, totalSymbols, totalDepEdges, totalCallEdges

**`CallGraph`** (`callgraph.json`) — `{ [symbolId]: CallGraphEntry }`
- `CallGraphEntry`: `calls: { name, file }[]`, `calledBy: string[]`

**`EmbeddingCache`** (`~/.vemora-cache/<id>/`)
- `embeddings`: `{ [chunkId]: number[] }` (Legacy JSON format)
- `vectors`: `Float32Array` (Runtime only, contiguous buffer)
- `chunkIds`: `string[]` (Ordered list of IDs matching the vectors buffer)
- `hnswIndex`: `any` (Serialised HNSW graph for fast retrieval)

**`KnowledgeEntry`** (`.vemora/knowledge/entries.json`)
- `id`: UUID v4
- `category`: `'decision' | 'pattern' | 'gotcha' | 'glossary'`
- `title`: short label shown in context headers
- `body`: free-form text, scored via term overlap during context ranking
- `relatedFiles?`: project-relative paths this entry is about
- `relatedSymbols?`: symbol names this entry is about
- `createdAt`: ISO timestamp; used for staleness detection
- `createdBy`: `"human"` or `"llm:<model-id>"`
- `confidence`: `'high' | 'medium' | 'low'`
- `supersedes?`: ID of the entry this replaces

**`SearchResult`**
- chunk, score (cosine similarity or TF), symbol (resolved SymbolEntry)

---

## `src/core/config.ts` — Configuration management

### Constants

```typescript
AI_MEMORY_DIR = '.vemora'
AI_MEMORY_CACHE_DIR = '.vemora-cache'
CONFIG_FILE = 'config.json'
METADATA_FILE = 'metadata.json'
INDEX_DIR = 'index'
FILES_JSON = 'files.json'
CHUNKS_JSON = 'chunks.json'
SYMBOLS_JSON = 'symbols.json'
DEPS_JSON = 'deps.json'
CALLGRAPH_JSON = 'callgraph.json'
SUMMARIES_DIR = 'summaries'
FILE_SUMMARIES_JSON = 'file-summaries.json'
PROJECT_SUMMARY_JSON = 'project-summary.json'
KNOWLEDGE_DIR = 'knowledge'
KNOWLEDGE_JSON = 'entries.json'
```

### Key functions

- `generateProjectId(rootDir)` — `sha256(rootDir).slice(0, 16)`. Deterministic per machine per directory.
- `getDefaultConfig(rootDir, projectName)` — returns a config with sensible defaults. Include patterns cover TS, JS, Python, Rust, Go, CSS, JSON, YAML, Markdown. Exclude patterns use `**/` prefix to catch nested directories (critical for monorepos). Default `summarization.model` is `gpt-4o-mini`.
- `loadConfig(rootDir)` — reads `config.json`, injects `rootDir`. Throws if not found.
- `saveConfig(config)` — strips `rootDir` before writing (it's runtime-only).
- `getSummariesDir(rootDir)` — returns `.vemora/summaries/` path.

---

## `src/storage/repository.ts` — Repository index I/O

`RepositoryStorage` class. All files are in `.vemora/index/` (or `.vemora/` for metadata).

Methods: `loadFiles/saveFiles`, `loadChunks/saveChunks`, `loadSymbols/saveSymbols`, `loadDeps/saveDeps`, `loadCallGraph/saveCallGraph`, `loadMetadata/saveMetadata`.

Private helpers:
- `readJson<T>(path, fallback)` — returns fallback if file missing or parse fails
- `writeJson(path, data)` — creates directories, writes with 2-space indent

---

## `src/storage/cache.ts` — Embedding cache I/O

`EmbeddingCacheStorage` class. Cache lives at `~/.vemora-cache/<projectId>/`.

Uses a dual-file approach for performance:
- `embeddings.json`: Metadata (model, dimensions) and ordered `chunkIds`.
- `embeddings.bin`: Raw `Float32Array` of all vectors for high-speed I/O.
- `embeddings.hnsw.json`: Serialized JSON representation of the HNSW index.

Methods:
- `load()` — returns `EmbeddingCache | null`. Loads metadata, binary vectors, and the HNSW index if present.
- `save(cache)` — splits data into JSON metadata, binary vectors, and the HNSW file.
- `update(newEmbeddings, cache)` — merges new embeddings, writes both files.
- `prune(validChunkIds, cache)` — removes stale entries and regenerates binary buffer.
- `getCacheDir()` — path accessor

---

## `src/storage/knowledge.ts` — Knowledge store I/O

`KnowledgeStorage` class. Entries live at `.vemora/knowledge/entries.json` (versioned in git).

Methods:
- `load()` — returns `KnowledgeEntry[]` (empty `[]` if file missing or parse error)
- `save(entries)` — creates directory if needed, writes JSON with 2-space indent
- `add(entry)` — load → push → save
- `remove(id)` — load → filter out → save; returns `false` if not found
- `hasKnowledge()` — `fs.existsSync(entriesPath)` (used by `status` to skip section)
- `getKnowledgeDir()` — path accessor

---

## `src/storage/summaries.ts` — Summary I/O

`SummaryStorage` class. Files live in `.vemora/summaries/` (versioned in git).

Methods:
- `loadFileSummaries()` — returns `FileSummaryIndex` (empty `{}` if not yet generated)
- `saveFileSummaries(index)` — writes `file-summaries.json`
- `loadProjectSummary()` — returns `ProjectSummary | null`
- `saveProjectSummary(summary)` — writes `project-summary.json`
- `hasFileSummaries()` / `hasProjectSummary()` — existence checks (used by `status` and `query`)
- `getSummariesDir()` — path accessor

---

## `src/indexer/scanner.ts` — File scanning

`scanRepository(config)` — async, returns `ScannedFile[]`.

Uses `fast-glob` with `cwd: rootDir`, `ignore: config.exclude`, `onlyFiles: true`. Results are sorted alphabetically for reproducible hashing across machines. The `ScannedFile` type carries `absolutePath`, `relativePath`, and `extension` (lowercase, no leading dot).

---

## `src/indexer/hasher.ts` — Hashing

- `hashFile(absolutePath)` — `sha256` of file buffer. Used for change detection.
- `hashContent(content)` — `sha256(content).slice(0, 16)`. Used for chunk IDs.

---

## `src/indexer/parser.ts` — Symbol extraction

Two modes, automatic selection:

**tree-sitter** (for `.ts`, `.tsx`, `.js`, `.jsx`): loaded at module init with `require()` wrapped in try/catch. If native bindings fail, `TreeSitterParser` is null and all files fall through to regex.

The AST visitor (`visitNode`) handles:
- `export_statement` → recurse with `insideExport: true`
- `function_declaration` / `generator_function_declaration` → function
- `class_declaration` → class + recurse into body for methods
- `method_definition` → method (with `parent` = class name)
- `lexical_declaration` / `variable_declaration` → function if RHS is arrow/function
- `interface_declaration` → interface
- `type_alias_declaration` → type
- default → recurse into children

**Regex fallback** (`parseWithRegex`): line-by-line matching against patterns for TS/JS, Python, Rust, Go. Returns `endLine === startLine` — no end line information.

Public API:
- `parseSymbols(filePath, content)` → `ParsedSymbol[]`
- `buildSymbolIndex(filePath, symbols)` → `SymbolIndex` (for merging into main index)

---

## `src/indexer/chunker.ts` — Code chunking

`chunkFile(filePath, content, symbols, config)` → `Chunk[]`

Decides mode based on whether any symbol has `endLine > startLine`:

**Symbol-boundary** (`chunkBySymbols`):
1. Sort symbols by `startLine`
2. Header chunk: lines before first symbol (up to 30 lines)
3. Per-symbol chunk, or sliding window if oversized
4. Trailing chunk: lines after last symbol

**Sliding window** (`chunkBySlidingWindow`):
- `maxChunkLines` window, 10% overlap
- Works on any `lines[]` + `lineOffset` (reused for oversized symbol sub-chunking)

`makeChunk(file, content, start, end, symbol?)` — generates the ID from `hashContent(file + '\n' + content)`.

---

## `src/indexer/deps.ts` — Dependency graph

### Import extraction

`extractRawImports(content)` — applies three regex patterns:
- `STATIC_IMPORT_RE`: standard `import ... from '...'`
- `EXPORT_FROM_RE`: `export { ... } from '...'`
- `DYNAMIC_RE`: `import(...)` / `require(...)`

`parseNamedImports(raw)` — parses `{ A, B as C, type D }` → `['A', 'D']` (original names, strips aliases and `type` keyword).

### Path resolution

`resolveImport(source, importerDir, allFiles)` — tries candidates in order:
1. `base + ''` (exact)
2. `base + '.ts'`, `.tsx`, `.js`, `.jsx`
3. `base/index.ts`, etc.
4. `.js` → `.ts` swap for TypeScript projects

Returns the first match found in `allFiles` (the Set of all indexed relative paths), or `null`.

### Graph management

- `extractFileImports(relativePath, content, allFiles)` → `ImportEntry[]` — full pipeline for one file
- `updateDependencyGraph(prevGraph, changedFiles, deletedFiles, allFiles)` → `DependencyGraph` — incremental update
- `computeImportedBy(graph)` → `Map<string, string[]>` — reverse edges, computed at runtime
- `getTransitiveDeps(startFile, graph, depth)` → `Map<string, number>` — BFS traversal returning distance per file
- `graphStats(graph)` → `{ totalFiles, totalEdges, mostImported[] }` — for display in index output

---

## `src/indexer/callgraph.ts` — Call Graph extraction

### Key functions

- `extractFileCalls(filePath, content, allFiles)` → `CallGraph[]` — uses tree-sitter to find `call_expression` nodes and resolve them to local or cross-file symbols.
- `buildGlobalCallGraph(prevGraph, changedFiles, deletedFiles, allFiles)` → `CallGraph` — iterative update of the global call relationships.

---

## `src/embeddings/provider.ts` — Interface

```typescript
interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}
```

---

## `src/embeddings/openai.ts` — OpenAI implementation

`OpenAIEmbeddingProvider(apiKey?, model?, dimensions?)`.

- Uses the `openai` npm package
- Batches inputs in groups of 100 (API limit is 2048, but 100 is safer for large chunks)
- Sorts response by `index` field to guarantee order matches input
- For `text-embedding-3-*` models: passes `dimensions` parameter (Matryoshka reduction)

---

## `src/embeddings/ollama.ts` — Ollama implementation

`OllamaEmbeddingProvider(model?, baseUrl?, dimensions?)`.

- Default model: `nomic-embed-text` (768 dims)
- Default baseUrl: `http://localhost:11434`
- Calls `/api/embeddings` one text at a time (Ollama doesn't support batching)
- Uses native `fetch` (Node 18+)

---

## `src/embeddings/noop.ts` — No-op implementation

Returns empty arrays. The query command detects empty embeddings and falls back to keyword search automatically. Used when `provider: "none"` in config.

---

## `src/embeddings/factory.ts` — Provider factory

`createEmbeddingProvider(config: EmbeddingConfig)` — switch on `config.provider`. The only place that knows about all implementations. Adding a new provider requires: implement `EmbeddingProvider`, add a case here.

---

## `src/utils/tokenizer.ts` — Token counting

Heuristic-based token counting for context optimization and benchmarking.

- `countTokensHeuristic(text)` — uses ~3.2 chars/token ratio for code.
- `formatTokenStats(text)` — returns a readable string with token count and KB size.
- `applyTokenBudget(results, budget)` — filters a ranked `SearchResult[]` to fit within a token budget. Accumulates chunks in score order; always includes at least the first result.

---

## `src/search/vector.ts` — Search implementations

### `vectorSearch(queryEmbedding, chunks, cache, symbols, topK)`

Performs a nearest-neighbor search.
- **HNSW Path**: If `cache.hnswIndex` is available, uses the HNSW graph for O(log N) search.
- **Optimized Binary Path**: Fallback if HNSW fails or is missing. Uses `cosineSimilarityBinary` on the contiguous `Float32Array` buffer.
- Returns top-K results sorted by score descending.

### `symbolLookup(query, chunks, symbols)`

Direct symbol lookup — bypasses embedding when the query matches a known symbol name. Returns chunks scored by match quality:
- `1.0` — exact match: `query === symbolName` (case-insensitive)
- `0.95` — single-word match: one word in query equals a symbol name
- `0.80` — prefix match: symbol name starts with a query word (or vice versa)

Returns `[]` if no match or if more than 5 symbols match (guards against generic names like `init`). When results are returned, `query.ts` and `context.ts` skip the embedding API call entirely.

### `cosineSimilarity(a, b)` / `cosineSimilarityBinary(query, vectors, offset, dims)`

Standard cosine similarity implementations. The binary version operates on `Float32Array` slices to minimize memory allocations and improve CPU cache locality.

Returns 0 for empty or mismatched vectors. Output is in [0, 1] for normalized embeddings.

---

## `src/search/bm25.ts` — BM25 Keyword Scoring

Implementazione dell'algoritmo BM25 per una ricerca testuale ad alta precisione.

### `computeBM25Scores(query, chunks, symbols, topK)`

Calcola il punteggio di pertinenza per ogni chunk basandosi sulla frequenza dei termini (TF) e sulla rarità (IDF).
- **Parametri**: `k1=1.5`, `b=0.75`.
- **Statistiche**: Calcola `avgdl` (lunghezza media documenti) al volo sull'intero set di chunk caricati.
- **Boost**: Applica un moltiplicatore ai chunk dove la query appare nel nome del simbolo.

---

## `src/search/hybrid.ts` — Hybrid Search Orchestration

Coordina la fusione dei risultati semantici e testuali.

### `hybridSearch(query, queryEmbedding, chunks, cache, symbols, options)`

Esegue sia la ricerca vettoriale che BM25 e combina i punteggi.
- **Normalizzazione**: I punteggi BM25 vengono normalizzati in [0, 1] rispetto al massimo trovato.
- **Fusion**: Calcola `alpha * vectorScore + (1 - alpha) * bm25Score`.
- **Fallback**: Se il provider LLM non supporta embedding, scala automaticamente sulla singola ricerca BM25.

---

## `src/search/merge.ts` — Adjacent chunk merging

### `mergeAdjacentChunks(results, gapThreshold?)`

Post-retrieval step that collapses adjacent or overlapping `SearchResult` entries from the same file into a single result.

**Algorithm:**
1. Group results by `chunk.file`
2. Within each group sort ascending by `chunk.start`
3. Merge while `next.start ≤ current.end + gapThreshold` (default: 3 lines)
   - Overlapping lines (from sliding-window chunks) are deduplicated: only lines of `next` beyond `current.end` are appended
4. Merged chunk: `start = min`, `end = max`, `score = max`, `symbol` kept only if identical across all merged chunks
5. Re-sort globally by score descending

**When to use:** after search/reranking and before budget capping. Reduces result count, eliminates content duplication at chunk boundaries, and provides longer coherent code spans to the LLM.

Activated with `--merge` (`--merge-gap <n>` to tune the gap threshold).

---

## `src/search/rerank.ts` — Cross-Encoder Reranking

Implementazione del secondo passaggio di ricerca (re-scoring) per migliorare la precisione.

### `rerankResults(query, results, topK)`

Prende i primi ~25 risultati da una ricerca iniziale (vettoriale o keyword) e li ri-ordina.
- **Modello**: `Xenova/ms-marco-MiniLM-L-6-v2`.
- **Logica**: Utilizza `AutoModelForSequenceClassification` per ottenere i **logits raw** di pertinenza per ogni coppia (query, chunk). I logits offrono una granularità superiore rispetto ai punteggi normalizzati della pipeline standard di `transformers.js`.
- **Performance**: Il modello viene caricato lazily e riutilizzato per le query successive.

---

## `src/search/signature.ts` — Signature extraction and display tiers

### `extractSignature(content)`

Extracts the declaration signature from chunk content — the part that describes *what* exists without the implementation body. Used for medium-tier results in query output.

Logic by content type:
- **Interface / type alias** — returns full content (up to 20 lines). These are compact by nature and the full declaration IS the signature.
- **Import blocks** — returns first 5 lines with `… (N more lines)` if longer.
- **Functions / classes / methods** — scans line by line until:
  - A line ending with `{` is found → appends `{ … }` in place of the body
  - A line ending with `=>` is found → appends `…` (arrow with expression body)
  - `MAX_SIG_LINES = 10` lines consumed → appends `  …`

Examples:
```
Input:  "export async function connect(\n  host: string,\n): Promise<void> {\n  body..."
Output: "export async function connect(\n  host: string,\n): Promise<void> { … }"

Input:  "export class ImapClient extends EventEmitter {\n  private socket..."
Output: "export class ImapClient extends EventEmitter { … }"

Input:  "export interface ImapConfig {\n  host: string;\n  port: number;\n}"
Output: (returned in full — interface IS the signature)
```

### `getDisplayTier(rank)` → `'high' | 'med' | 'low'`

Maps result rank (1-based) to display tier:
- Rank 1–3 → `'high'`
- Rank 4–7 → `'med'`
- Rank 8+  → `'low'`

### `HIGH_CODE_LINES = 30`

Maximum lines shown automatically for high-tier results without `--show-code`.

---

## `src/llm/factory.ts` — LLM Factory

Instantiates the correct `LLMProvider` base on the configuration. Supports `openai`, `anthropic`, and `ollama`.

## `src/llm/anthropic.ts` — Anthropic Provider

Implementation for Anthropic's Messages API. Supports streaming and requires `ANTHROPIC_API_KEY`.

## `src/llm/ollama.ts` — Ollama Provider

Implementation for local Ollama chat API. Support streaming and uses a local `baseUrl`.

## `src/commands/ask.ts` — `vemora ask`

`runAsk(rootDir, question, options)` — one-shot Q&A: retrieves relevant context from the index and calls the configured LLM to answer the question directly. No interactive loop.

**Options:** `topK` (chunks to retrieve, default 5), `keyword` (BM25 only, no embeddings), `hybrid` (vector+BM25), `budget` (max context tokens, default 6000), `showContext` (print retrieved context before the answer).

**Flow:**
1. Search (BM25 if `keyword` or no embeddings; vector or hybrid otherwise)
2. `applyTokenBudget` to cap context size
3. `generateContextString` in plain format (imported from `context.ts`)
4. `llm.chat([{ role: "system", content: systemPrompt + context }, { role: "user", content: question }])` with streaming via `onToken`
5. Falls back to printing `response.content` if the provider doesn't support streaming

Requires `config.summarization` to be set; prints a clear error with example config if missing. Useful for scripting, CI/CD pipelines, and local models where the caller should not need to orchestrate multiple commands.

---

## `src/commands/chat.ts` — `vemora chat`

Implementazione del middleware interattivo. 

### `runChat(rootDir, options)`
- Apre un'interfaccia `readline` per il loop utente.
- Per ogni messaggio:
  1. Esegue una ricerca vettoriale/keyword sul database locale.
  2. Applica il **Reranking** locale per scegliere i 5 chunk più pertinenti.
  3. Formatta il contesto in Markdown.
  4. Chiama l'LLM con un prompt di sistema che include l'overview del progetto e il contesto trovato.
  5. Mantiene una cronologia limitata per supportare il dialogo.

---

## `src/commands/init-agent.ts` — `vemora init-agent`

`runInitAgent(rootDir, { agents?, force?, hooks? })` — generates AI agent instruction files from the existing index. No API calls made.

When `hooks: true` and `"claude"` is in the target list, also calls `writeClaudeHooks(rootDir, force)` which writes a `PreCompact` hook entry into `.claude/settings.json`. Existing hooks outside the vemora-managed key are preserved. If `PreCompact` already exists and `force` is false, the hook write is skipped with a warning.

Supported agents and output paths:

| Agent | File |
|---|---|
| `claude` | `CLAUDE.md` |
| `copilot` | `.github/copilot-instructions.md` |
| `cursor` | `.cursor/rules/vemora.mdc` (with YAML frontmatter `alwaysApply: true`) |
| `windsurf` | `.windsurfrules` |

Default (no `agents` specified) = all four.

Each file shares:
- `DEFAULT_INSTRUCTIONS` — two-layer static preamble: (1) five abstract guidelines for large cloud models, (2) a `## Quick reference` table with explicit IF/THEN rules for small/local models. Both layers benefit all model sizes; large models use the table as a cheat sheet, small models follow it literally.
- The generated block: Project Overview, Commands, Entry Points, Key Exports, vemora usage examples including `remember` and `knowledge list`.

Differences between agents are in the wrapper only: Claude gets `# projectName` header, Cursor gets YAML frontmatter `alwaysApply: true`.

Merge behavior (same for all agents):
- File doesn't exist → create from scratch
- File has `<!-- vemora:generated:start/end -->` markers → replace only the block between them, preserve custom content outside
- File exists without markers + `--force` → full overwrite
- File exists without markers + no `--force` → print yellow warning with marker instructions, skip

Contains `buildGeneratedBlock` and `detectNpmScripts` (shared utilities).

---

## `src/commands/init-claude.ts` — `vemora init-claude`

Thin wrapper: delegates to `runInitAgent(rootDir, { agents: ["claude"], force })`. Kept for backward compatibility.

---

## `src/commands/init.ts` — `vemora init`

`runInit(rootDir)`:
1. `mkdir -p .vemora/index/`
2. Write `config.json` (skip if exists)
3. Write `metadata.json` (skip if exists)
4. Write empty `files.json`, `chunks.json`, `symbols.json` (skip if exist)
5. Ensure `.vemora-cache/` is in `.gitignore`

`detectProjectName(rootDir)` — reads `package.json` name, falls back to `pyproject.toml` name, then `path.basename(rootDir)`.

`ensureGitignore(rootDir)` — appends entry if missing, skips if already present.

---

## `src/commands/index.ts` — `vemora index`

Orchestrates the indexing process. Refactored to support iterative and watched indexing.

### `runIndex(rootDir, { force?, noEmbed?, watch? })`
1. Performs an initial full or incremental index via `performIndexIteration`.
2. Saves updated files, chunks, symbols, and deps to storage.
3. Generates embeddings for any new/changed chunks.
4. Updates project metadata.
5. If `--watch` is true: starts a `chokidar` instance via `startWatcher`.

### `performIndexIteration(rootDir, config, repo, options, specificPaths?)`
The core logic of a single indexing pass. 
- If `specificPaths` are provided (from watcher), it only processes those. 
- Otherwise, it scans the entire repo. 
- Returns the new state (`FileIndex`, `Chunk[]`, etc.) and the list of affected paths.

### `startWatcher(...)`
Initializes `chokidar` to monitor the project root.
- **Ignored**: `node_modules`, `.git`, `.vemora`.
- **Logic**: Collects changes (`add`, `change`, `unlink`) into pending sets.
- **Debounce**: Triggers `triggerIndex` after 500ms of inactivity.
- **triggerIndex**: Calls `performIndexIteration` with the specific changed/deleted paths for rapid partial updates.

### `updateMetadata(prev, files, chunks, symbols, deps, callGraph)`
Calculates final stats and updates `lastIndexed` timestamp.

### `generateEmbeddings(chunks, prevCache, config, cacheStorage)`
- Filters to chunks without cached embeddings.
- Prefixes text with `file:` and `symbol:` metadata before embedding.
- Prunes stale entries from local cache, then merges new vectors.
- Returns the updated `EmbeddingCache`.

### `rebuildHNSWIndex(chunks, cache, cacheStorage)`
- Builds a new HNSW index from all current embeddings.
- Uses `hnsw` library with `M=16` and `efConstruction=200`.
- Serializes the index to `hnswIndex` and saves it via `cacheStorage`.

---

## `src/commands/query.ts` — `vemora query`

`runQuery(rootDir, question, options)` — supports `QueryOptions`:

| Option | Flag | Description |
|---|---|---|
| `topK` | `-k` | Number of results (default: 10) |
| `showCode` | `-c` | Print full code snippets |
| `keyword` | `--keyword` | Force keyword (BM25) search |
| `format` | `--format` | `terminal` / `json` / `markdown` |
| `rerank` | `--rerank` | Cross-encoder re-scoring |
| `hybrid` | `--hybrid` | Vector + BM25 fusion |
| `alpha` | `--alpha` | Hybrid vector weight (0–1) |
| `budget` | `--budget` | Max tokens across results |
| `mmr` | `--mmr` | MMR diversity deduplication |
| `lambda` | `--lambda` | MMR relevance weight |
| `merge` | `--merge` | Merge adjacent/overlapping chunks |
| `mergeGap` | `--merge-gap` | Max gap (lines) to still merge (default: 3) |

Pipeline order: search → rerank → MMR → **merge** → budget → output.

LOW tier results show `◦ <file summary>` if a summary exists for that file.

## `src/commands/summarize.ts` — `vemora summarize`

`runSummarize(rootDir, { force?, model?, filesOnly?, projectOnly? })`:

1. Load `FileIndex` (for content hashes) and previous `FileSummaryIndex`
2. Filter to files needing re-generation: hash changed or `--force`
3. For each file: read content (truncated to 4000 chars), collect exported symbol names, call OpenAI chat completion with `fileSummaryPrompt`
4. Save updated `FileSummaryIndex` incrementally

**Project overview phase** (skipped if `--files-only`):
- Triggered if any file summary changed, `--force`, or `--project-only`
- Builds a sorted block of `file: summary` pairs (capped at 12000 chars)
- Calls OpenAI with `projectOverviewPrompt` → `ProjectSummary`

Models: default `gpt-4o-mini` (from `config.summarization.model`). API key from `OPENAI_API_KEY` env or `config.summarization.apiKey`. Max tokens: 250 per file, 750 for project overview.

---

## `src/commands/context.ts` — `vemora context`

`runContext(rootDir, options)` — accepts the same search/pipeline flags as `query` (`--hybrid`, `--rerank`, `--mmr`, `--merge`, `--merge-gap`, `--budget`, etc.) plus:

- `--query <text>` — natural-language query; runs the full search pipeline and includes top-K results
- `--file <path>` — includes a specific file in full with its dep graph

At least one of `--query` or `--file` must be provided.

Generates a single Markdown (or plain text) context block meant to be pasted into any LLM prompt. Combines up to four sections:

1. **Project overview** — `projectSummary.overview` from `SummaryStorage` (omitted if not yet generated)
2. **Knowledge** — top-5 `KnowledgeEntry` items ranked by file/symbol/query overlap (see `rankKnowledgeEntries`); omitted if no entries exist
3. **File context** (`--file`) — full file content as a fenced code block, followed by its intra-project imports and used-by list from the dep graph
4. **Relevant code** (`--query`) — top-K chunks from vector/keyword search (pipeline: rerank → MMR → **merge** → budget), each with dep context (Imports/Used by) and call graph context (Calls/Called by)

`--structured` mode reorganizes the output into semantic sections: **Entry Point → Direct Dependencies → Called By → Types & Interfaces → Related Patterns**, with the Knowledge section prepended to all.

Path resolution: `resolveRelPath(rootDir, filePath)` tries candidates in order: (1) path as-is relative to `rootDir`, (2) path resolved from `cwd`.

Output is written to `stdout`, designed to be piped: `vemora context --query "X" > context.md`

---

## `src/commands/bench.ts` — `vemora bench`

### `runBench(rootDir, query, options)`
1. Performs a search for the query (keyword or vector).
2. Generates two context strings:
   - **Minimal**: Basic chunks + overview.
   - **Full**: Includes dependencies, call graph, and file summaries.
3. Estimates tokens for both using `src/utils/tokenizer.ts`.
4. Prints a comparison table highlighting the "overhead" of advanced features.

---

## `src/commands/status.ts` — `vemora status`

`runStatus(rootDir)`:
- Loads config, index metadata, and local embedding cache.
- Prints project summary (Files, Chunks, Symbols, Provider) and local cache (Vectors, Model, Location).
- If file summaries exist: shows count and whether the project overview has been generated.
- If `.vemora/knowledge/entries.json` exists: shows entry count and runs **staleness detection** — for each entry with `relatedFiles`, checks if any listed file has `lastModified > entry.createdAt`. Prints a yellow `⚠` warning per stale entry.

---

## `src/commands/overview.ts` — `vemora overview`

`runOverview(rootDir)`:
- Carica il summary del progetto da `.vemora/summaries/project-summary.json`.
- Stampa la panoramica generale del repository generata da `summarize`.

---

## `src/search/formatter.ts` — JSON / Markdown formatters

Contains two output formatters used by `query --format`.

### `formatJson(query, results, depGraph, fileSummaries, options)` → `string`

Returns a JSON string with schema:
```json
{
  "query": "...",
  "totalResults": 5,
  "results": [
    {
      "rank": 1,
      "tier": "high",
      "file": "src/...",
      "symbol": "connect",
      "symbolType": "function",
      "lines": { "start": 42, "end": 89 },
      "score": 0.9341,
      "code": "...",        // non-null for tier=high
      "signature": null,    // non-null for tier=med
      "imports": [...],
      "usedBy": [...],
      "summary": null       // non-null if fileSummaries has an entry
    }
  ]
}
```

### `formatMarkdown(query, results, depGraph, fileSummaries, options)` → `string`

Returns a Markdown string with:
- H2 header with the query
- H3 per result with file path and symbol label
- Import / used-by lists
- Fenced code block with language tag inferred from file extension
- Tier-based content: full code (high), signature (med), AI summary blockquote (low)

---

## `src/commands/remember.ts` — `vemora remember`

`runRemember(rootDir, body, options)` — adds a knowledge entry to the store.

Options (`RememberOptions`): `category`, `title`, `files`, `symbols`, `confidence`, `createdBy`, `supersedes`.

Pipeline:
1. Validates `body.length >= 20` (exits with error if too short).
2. Auto-derives `title` from first sentence of `body`, capped at 80 chars.
3. Duplicate detection: computes term overlap between `body` and each existing entry; warns if any entry has > 60% term overlap (without blocking the write).
4. **Auto-classification**: if `category` is not provided, calls `classifyCategory(body, config)` via the configured LLM (same provider as `summarization` or `planner`). The LLM returns one of `decision | pattern | gotcha | glossary`. Falls back silently to `"pattern"` if no LLM is configured or the call fails.
5. Creates a `KnowledgeEntry` with a UUID v4 `id` and `createdAt: new Date().toISOString()`.
6. Calls `KnowledgeStorage.add(entry)` and prints a confirmation with the short ID.

Default values: `confidence = 'medium'`, `createdBy = 'human'`. `category` has no hardcoded default — it is auto-classified when omitted.

---

## `src/commands/brief.ts` — `vemora brief`

`runBrief(rootDir, options)` — prints a compact session primer.

Options (`BriefOptions`): `all` (boolean, default `false`).

Pipeline:
1. Loads `ProjectSummary` from `SummaryStorage` (if available).
2. Loads all `KnowledgeEntry` items from `KnowledgeStorage`.
3. Filters entries to `confidence === 'high'` unless `options.all` is set.
4. Groups filtered entries by `category` and renders each group.
5. Body text is capped at 120 chars per entry to keep token use minimal.

Output structure:
```
# <projectName> — session brief

## Overview
<project-summary.json overview>

## Critical knowledge (N)

<category>
- **<title>**
  <body preview>
```

Designed as an L0+L1 context load at session start: ~170 tokens for a typical project with a summary and a handful of high-confidence entries.

---

## `src/commands/knowledge.ts` — `vemora knowledge`

### `runKnowledgeList(rootDir, options)`

Lists all entries grouped by category with color-coded headers.

- Category display order: `gotcha` (red) → `pattern` (cyan) → `decision` (yellow) → `glossary` (gray)
- Each entry shows: confidence dot (green/yellow/gray), bold title, short ID in brackets
- If `body !== title`, shows a 120-char preview of `body`
- Shows `relatedFiles` and `relatedSymbols` if present
- Shows `supersedes` (short ID) if set
- Filter options: `--category`, `--file` (substring match on `relatedFiles`), `--symbol` (exact match on `relatedSymbols`)

### `runKnowledgeForget(rootDir, id)`

Removes an entry by full UUID or 8-char prefix. Prints an error and exits with code 1 if not found.

---

## `src/commands/deps.ts` — `vemora deps`

`runDeps(rootDir, targetFile, { depth? })`:

1. Load depGraph
2. Compute `importedByMap`
3. Print outgoing imports (direct or transitive via `getTransitiveDeps`)
4. Print incoming (used-by) with the symbols they extract
5. Print "Suggested context for LLM" — union of the file itself, its imports, and its callers

The transitive display groups results by BFS depth level.

---

## `src/commands/dead-code.ts` — `vemora dead-code`

`runDeadCode(rootDir, { types?, output? })` — static dead-code analysis from the existing index. No LLM or API key required.

Three detectors, each returning `DeadCodeFinding[]` sorted by file + line:

**`findUncalledPrivate(symbols, callGraph)`**
Iterates all non-exported `function` and `method` symbols. For each, looks up `callGraph["file:shortName"]`. Only flags when a call graph entry explicitly exists with `calledBy.length === 0` — symbols absent from the call graph entirely are skipped (call graph coverage may be incomplete). Constructors are excluded.

**`findUnusedExports(symbols, depGraph)`**
Builds a map of `file → Set<importedSymbolNames>` from the dep graph. Files imported via namespace (`import * as X`, represented as `symbols: []`) are excluded from flagging entirely. An exported symbol is flagged if its name doesn't appear in any `ImportEntry.symbols` for its file. `interface` and `type` symbols are excluded (erased at runtime, dep graph may not track them).

**`findUnreachableFiles(symbols, depGraph)`**
Uses `computeImportedBy` to find files not in the importedBy map. Only flags files that have at least one exported symbol (intended to be a module). Excludes common entry point filenames: `cli.ts`, `index.ts`, `main.ts`, `server.ts`, `app.ts`.

Output formats: `terminal` (default, color-coded with file:line references) and `json` (flat array of `DeadCodeFinding` objects).

---

## Important constants to know

```typescript
MAX_DEP_LINES = 4        // max imports shown per result in query output
MAX_USED_BY = 3          // max callers shown per result in query output
BATCH_SIZE = 100         // OpenAI embedding batch size
DEFAULT_TOP_K = 10       // default results per query
DEFAULT_CHUNK_LINES = 80 // default max lines per chunk
DEFAULT_CHUNK_CHARS = 3000
OVERLAP_RATIO = 0.10     // sliding window overlap (10%)
HEADER_MAX_LINES = 30    // max lines for the file header chunk
MIN_HEADER_CONTENT = 30  // min chars to emit a header chunk
MIN_TAIL_CONTENT = 50    // min chars to emit a trailing chunk
KEYWORD_MIN_TERM = 3     // minimum term length for keyword search
// signature.ts
MAX_SIG_LINES = 10       // max lines scanned to extract a signature
HIGH_CODE_LINES = 30     // max lines auto-shown for high-tier results
// query.ts display tiers (rank-based, 1-indexed)
HIGH_TIER_MAX_RANK = 3   // ranks 1-3 → full code
MED_TIER_MAX_RANK = 7    // ranks 4-7 → signature only
                         // ranks 8+  → file + symbol + score only
// deps in query output (vary by tier)
MAX_DEP_LINES_HIGH = 6   // imports shown for high-tier
MAX_DEP_LINES_MED = 3    // imports shown for med-tier
MAX_USED_BY_HIGH = 4
MAX_USED_BY_MED = 2
```

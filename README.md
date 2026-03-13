# ai-memory

Repository-local memory system for LLM-assisted development.

Builds a structured, versioned index of your codebase — code chunks, symbols, dependency graph, and LLM-generated summaries — and enables semantic or keyword search over it. The result is a **RAG (Retrieval-Augmented Generation) layer** that lets you give an LLM only the code it actually needs, instead of entire files.

## Why

When working on a large codebase with Claude Code or similar LLM tools, you face two problems:

1. **Context cost** — dropping 50 files into the context wastes tokens on irrelevant code
2. **Discovery** — you don't always know *which* files are relevant to a given task

`ai-memory` solves both by pre-indexing the repo and making it queryable.

## Architecture in three layers

```
.ai-memory/          ← versioned in git, shared across the team
  config.json
  metadata.json
  index/
    files.json       ← file hashes for incremental indexing
    chunks.json      ← code chunks (function/class/window slices)
    symbols.json     ← extracted symbol map
    deps.json        ← intra-project dependency graph
    callgraph.json   ← function-level call relationships
    todos.json       ← TODO/FIXME/HACK/XXX annotations extracted from source
  summaries/
    file-summaries.json   ← LLM-generated 2-3 line description per file
    project-summary.json  ← LLM-generated ~500 word project overview
  knowledge/
    entries.json     ← human/LLM-authored notes: decisions, gotchas, patterns

~/.ai-memory-cache/<projectId>/    ← local to each developer, NOT in git
  embeddings.json                  ← metadata (model, dimensions, chunk mapping)
  embeddings.bin                   ← binary buffer of vectors (Float32Array)
  embeddings.hnsw.json             ← serialized HNSW index for ultra-fast search
```

The index, summaries, and knowledge entries are committed to git so teammates share them. Embeddings are generated locally by each developer from the shared index.

## Installation

```bash
# Inside the ai-memory/ directory
npm install
npm run build

# Link globally (optional)
npm link
```

Or run directly with `node ai-memory/dist/cli.js` from the project root.

## The Core Workflow

### 1. Setup (first time only)

```bash
ai-memory init                  # create .ai-memory/ and config.json
ai-memory index --no-embed      # build index without embeddings (fast)
ai-memory index                 # or: build index + generate embeddings
ai-memory summarize             # optional: generate LLM descriptions per file
ai-memory init-agent            # generate instruction files for AI agents
```

### 2. Query during development

```bash
# Search for relevant code
ai-memory query "how does IMAP reconnect work?"

# Full context block ready to paste into any LLM
ai-memory context --query "email retry logic" > context.md

# One-shot answer from the configured LLM
ai-memory ask "why does the sync queue stall?"

# Save a finding for future sessions
ai-memory remember "EmailService.send queues if SMTP is offline — see OutboxRepository"
```

### 3. Keep the index fresh

```bash
ai-memory index --watch         # incremental re-index on file save
ai-memory index --no-embed      # after code changes, update structure only
```

## Commands

### `ai-memory init`

Creates the `.ai-memory/` folder structure and adds `.ai-memory-cache/` to `.gitignore`.

```
Options:
  --root <dir>   project root (default: cwd)
```

### `ai-memory index`

Scans the repo, parses symbols, builds the dependency graph, extracts TODO/FIXME/HACK/XXX annotations, and generates embeddings. **Incremental** — only re-processes files whose SHA-256 hash has changed.

```
Options:
  --root <dir>   project root (default: cwd)
  --force        re-index all files, ignoring hashes
  --no-embed     skip embedding generation (index structure only)
  -w, --watch    watch for changes and re-index automatically
```

### `ai-memory query "<question>"`

Searches the index using vector similarity (or keyword fallback). Results use a **three-tier display** that compresses output by relevance rank.

```
Options:
  --root <dir>        project root (default: cwd)
  -k, --top-k <n>     number of results (default: 10)
  -c, --show-code     show full code for all results (overrides tier system)
  --keyword           force keyword/BM25 search (no API call needed)
  --format <fmt>      output format: terminal (default) | json | markdown | terse
  --rerank            re-score results with a cross-encoder model
  --hybrid            use hybrid search (vector + BM25)
  --alpha <n>         hybrid weight for vector search (0-1, default 0.7)
  --budget <n>        max tokens to include across results
  --mmr               apply Maximal Marginal Relevance to diversify results
  --merge             merge adjacent chunks from the same file
```

#### Output formats

| Format | Use case |
|---|---|
| `terminal` | Default coloured output for interactive use |
| `json` | Machine-readable — for piping to scripts |
| `markdown` | Paste-ready Markdown with code blocks |
| `terse` | One line per result — recommended for small/local models |

Terse format example:
```
src/core/email/services/email.service.ts:45 | EmailService.send (method) | 0.912 | async send(email: Email): Promise<void>
src/infrastructure/protocols/smtp/smtp.service.ts:12 | SmtpService.connect (method) | 0.841 | async connect(config: SmtpConfig): Promise<void>
```

#### Output tiers (terminal/markdown)

| Rank | Tier | Content shown |
|------|------|--------------|
| 1–3  | high | Full code block (capped at 30 lines) |
| 4–7  | med  | Declaration signature only |
| 8+   | low  | File path + symbol + score + AI summary |

### `ai-memory context`

Generates an **optimized LLM context block** combining project overview, a specific file, and relevant code chunks. Designed to be piped to a file or clipboard.

```
Options:
  --root <dir>          project root (default: cwd)
  -q, --query <text>    natural-language query to find relevant code
  -f, --file <path>     include a specific file in full with its dependency graph
  -k, --top-k <n>       number of search results to include (default: 5)
  --keyword             use keyword search instead of semantic search
  --show-code           show full code without line cap
  --format <fmt>        output format: markdown (default) | plain | terse
  --rerank              re-score results with a cross-encoder model
  --hybrid              use hybrid search (vector + BM25)
  --budget <n>          max tokens to include across retrieved chunks
  --structured          emit a structured block (Entry Point / Dependencies / Types / Patterns)
```

At least one of `--query` or `--file` is required.

When `--file` is used, the context block also includes:
- **Recent git commits** that touched the file (last 5, via `git log --follow`)
- **TODO/FIXME/HACK/XXX annotations** present in the file (from the index)

### `ai-memory ask "<question>"`

One-shot Q&A: retrieves relevant context and calls the configured LLM to answer directly. No interactive loop.

```
Options:
  --root <dir>        project root (default: cwd)
  -k, --top-k <n>     chunks to retrieve (default: 5)
  --keyword           use keyword search (no embeddings needed)
  --hybrid            use hybrid vector+BM25 search
  --budget <n>        max context tokens to send to LLM (default: 6000)
  --show-context      print the retrieved context before the answer
```

Requires `summarization` to be configured in `config.json`. Useful for local models (Ollama) where the agent does not need to orchestrate multiple commands.

```bash
ai-memory ask "how does the IMAP reconnect logic work?" --root .
ai-memory ask "what does EmailService.send do?" --root . --keyword
```

### `ai-memory remember "<text>"`

Saves a persistent knowledge entry to `.ai-memory/knowledge/entries.json`. The entry is committed to git and included automatically in future `context` and `ask` results when relevant.

```
Options:
  --root <dir>            project root (default: cwd)
  --category <cat>        decision | pattern | gotcha | glossary (default: decision)
  --files <paths>         comma-separated related file paths
  --symbols <names>       comma-separated related symbol names
  --confidence <level>    high | medium | low (default: medium)
```

```bash
ai-memory remember "EmailService.send queues if SMTP offline — see OutboxRepository" \
  --category gotcha \
  --files src/core/email/services/email.service.ts \
  --symbols EmailService.send
```

### `ai-memory knowledge`

Manages saved knowledge entries.

```bash
ai-memory knowledge list --root .          # list all entries grouped by category
ai-memory knowledge forget <id> --root .   # remove an entry by ID (prefix match)
```

### `ai-memory init-agent`

Generates AI agent instruction files from the existing index. Supports Claude Code, GitHub Copilot, Cursor, and Windsurf.

```
Options:
  --root <dir>            project root (default: cwd)
  --agents <list>         comma-separated: claude,copilot,cursor,windsurf (default: all)
  --force                 overwrite existing files that have no ai-memory markers
```

| Agent | Output file |
|---|---|
| `claude` | `CLAUDE.md` |
| `copilot` | `.github/copilot-instructions.md` |
| `cursor` | `.cursor/rules/ai-memory.mdc` (with `alwaysApply: true`) |
| `windsurf` | `.windsurfrules` |

Each file includes a **two-layer instruction set**: abstract guidelines (for large cloud models) and an explicit quick-reference table (for small/local models).

Re-running `init-agent` only updates the auto-generated block between `<!-- ai-memory:generated:start/end -->` markers. Custom content outside the markers is preserved.

### `ai-memory init-claude`

Thin wrapper for `init-agent --agents claude`. Kept for backward compatibility.

### `ai-memory summarize`

Generates LLM-powered summaries for every indexed file and a high-level project overview. **Incremental** — only re-generates summaries for files whose content has changed.

```
Options:
  --root <dir>       project root (default: cwd)
  --force            re-generate all summaries
  --model <name>     override LLM model (default: gpt-4o-mini)
  --files-only       only generate per-file summaries
  --project-only     (re)generate project overview from existing file summaries
```

### `ai-memory status`

Prints index stats, embedding cache info, knowledge store summary (with staleness warnings), and a count of TODO/FIXME/HACK/XXX annotations by type.

### `ai-memory deps <file>`

Shows the full dependency context for a file: what it imports, what imports it.

```
Options:
  --root <dir>      project root (default: cwd)
  -d, --depth <n>   transitive depth for outgoing imports (default: 1)
```

### `ai-memory overview`

Prints the project overview to stdout.

```bash
ai-memory overview --root . > OVERVIEW.md
```

### `ai-memory chat`

Interactive chat session with the codebase. Supports OpenAI, Anthropic, and Ollama.

```bash
ai-memory chat
ai-memory chat --provider anthropic --model claude-3-5-sonnet-20240620
ai-memory chat --provider ollama --model qwen2.5-coder:14b
```

### `ai-memory report`

Shows a usage statistics report: commands breakdown, search method distribution, token savings from each optimization step (semantic dedup, session filter, budget cap), and most frequent query terms.

```
Options:
  --root <dir>   project root (default: cwd)
  --days <n>     limit report to events from the last N days
  -v, --verbose  show per-query breakdown (last 20 queries)
  --clear        clear all recorded usage data
```

Usage is tracked automatically on every `query`, `context`, and `ask` invocation. Data is stored locally at `~/.ai-memory-cache/<projectId>/usage.log.json` (never committed to git).

```bash
ai-memory report --root .            # full report
ai-memory report --root . --days 7   # last week only
ai-memory report --root . --verbose  # + per-query log
ai-memory report --root . --clear    # reset usage history
```

### Session flags (`--session`, `--fresh`)

Both `query` and `context` support session memory: chunks already seen in the current session are skipped to avoid re-sending redundant context to the LLM.

```
--session   skip chunks already seen in this session (auto-expires after 30 min idle)
--fresh     reset session memory before this query
```

```bash
ai-memory query "email retry logic" --root . --session
ai-memory context --root . --query "sync engine" --session --fresh
```

### `ai-memory bench <query>`

Compares token consumption between minimal and full context modes.

---

## Configuration

Edit `.ai-memory/config.json` after `init`:

```json
{
  "projectId": "b88eb8199f78331e",
  "projectName": "my-app",
  "version": "1.0.0",
  "include": ["**/*.ts", "**/*.tsx"],
  "exclude": ["**/node_modules/**", "**/dist/**"],
  "maxChunkLines": 80,
  "maxChunkChars": 3000,
  "embedding": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "dimensions": 1536
  },
  "summarization": {
    "provider": "openai",
    "model": "gpt-4o-mini"
  },
  "display": {
    "format": "terse"
  }
}
```

### `display.format`

Sets the default output format for `query`, `context`, and `ask`. Set to `"terse"` for small/local models with limited context windows. Can always be overridden per-command with `--format markdown`.

### Embedding providers

| Provider | Config | Notes |
|---|---|---|
| `openai` | `OPENAI_API_KEY` env or `apiKey` in config | Best quality. Requires `npm install openai`. |
| `ollama` | `baseUrl` (default: `http://localhost:11434`) | Local, no cost, no extra install. |
| `none` | — | Keyword search only, no embeddings. |

### LLM providers

Used by `ask`, `chat`, and `summarize`. The embedding provider and LLM provider are configured independently.

| Provider | Config | Notes |
|---|---|---|
| `openai` | `OPENAI_API_KEY` env or `apiKey` in config | Requires `npm install openai`. |
| `anthropic` | `ANTHROPIC_API_KEY` env or `apiKey` in config | Requires `npm install @anthropic-ai/sdk`. |
| `ollama` | `baseUrl` (default: `http://localhost:11434`) | Local, no cost, no extra install. |

> Note: Anthropic does not offer an embedding API. If you use `anthropic` as your LLM provider, you still need to choose a separate embedding provider (`openai` or `ollama`).

### Using local models (Ollama)

Fully offline workflow with no API keys required:

```bash
ollama pull nomic-embed-text      # 274 MB — embeddings
ollama pull qwen2.5-coder:14b     # ~9 GB — recommended for 16 GB RAM
```

```json
{
  "embedding": {
    "provider": "ollama",
    "model": "nomic-embed-text",
    "baseUrl": "http://localhost:11434",
    "dimensions": 768
  },
  "summarization": {
    "provider": "ollama",
    "model": "qwen2.5-coder:14b",
    "baseUrl": "http://localhost:11434"
  },
  "display": { "format": "terse" }
}
```

The `query` and `context` commands do not call the LLM — they only use embeddings. The LLM is called only by `ask`, `chat`, and `summarize`.

---

## What goes in git

```
✓ .ai-memory/config.json
✓ .ai-memory/metadata.json
✓ .ai-memory/index/files.json
✓ .ai-memory/index/chunks.json
✓ .ai-memory/index/symbols.json
✓ .ai-memory/index/deps.json
✓ .ai-memory/index/callgraph.json
✓ .ai-memory/summaries/file-summaries.json
✓ .ai-memory/summaries/project-summary.json
✓ .ai-memory/knowledge/entries.json    ← shared knowledge store

✗ .ai-memory-cache/                    ← local embedding vectors (gitignored)
```

## Incremental indexing

Chunk IDs are derived from `sha256(filePath + content)`. If a function's code doesn't change, its chunk ID is stable across branches — embeddings are reused without any API call.

## Tech stack

- **TypeScript + Node.js** (CommonJS, ES2022 target)
- **commander** — CLI framework
- **fast-glob** — repository scanning
- **tree-sitter** (optional) — AST-based symbol extraction for TS/JS
- **openai** SDK _(optional)_ — embedding generation and OpenAI LLM provider; install with `npm install openai`
- **@anthropic-ai/sdk** _(optional)_ — Anthropic/Claude LLM provider; install with `npm install @anthropic-ai/sdk`
- **@xenova/transformers** — local cross-encoder model for `--rerank`
- **hnsw** — HNSW index for sub-millisecond vector search
- **chokidar** — file watching for `--watch` mode
- **chalk + ora** — terminal output

# vemora

[![npm version](https://img.shields.io/npm/v/vemora?label=npm)](https://www.npmjs.com/package/vemora)
[![npm alpha](https://img.shields.io/npm/v/vemora/alpha?label=alpha)](https://www.npmjs.com/package/vemora?activeTab=versions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Repository-local memory system for LLM-assisted development.

Builds a structured, versioned index of your codebase — code chunks, symbols, dependency graph, and LLM-generated summaries — and enables semantic or keyword search over it. The result is a **RAG (Retrieval-Augmented Generation) layer** that lets you give an LLM only the code it actually needs, instead of entire files.

## Why

When working on a large codebase with Claude Code or similar LLM tools, you face two problems:

1. **Context cost** — dropping 50 files into the context wastes tokens on irrelevant code
2. **Discovery** — you don't always know *which* files are relevant to a given task

`vemora` solves both by pre-indexing the repo and making it queryable. It also provides higher-level commands that go beyond retrieval:

- **`vemora plan`** — a pro LLM (planner) decomposes a complex task into concrete steps; a smaller/free LLM (executor) carries out each step against targeted code context. Cuts costs by using expensive models only where they matter.
- **`vemora audit`** — systematic, checklist-driven analysis of your codebase for security vulnerabilities, performance issues, and bugs. Covers every file, produces structured findings with severity levels.
- **`vemora triage`** — zero-LLM static heuristic scan for bugs, security issues, and performance problems. Instant results with no API calls, useful as a first pass before a deeper audit.
- **`vemora dead-code`** — zero-LLM static analysis that detects unused private symbols, exports nobody imports, and files that are never imported. Works entirely from the call graph and dependency graph already in the index.
- **`vemora focus`** — aggregates all structural context about a file or symbol in one shot: implementation, exports, dependency graph, callers, test files, and saved knowledge.

## Architecture in three layers

```
.vemora/          ← versioned in git, shared across the team
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

~/.vemora-cache/<projectId>/    ← local to each developer, NOT in git
  embeddings.json                  ← metadata (model, dimensions, chunk mapping)
  embeddings.bin                   ← binary buffer of vectors (Float32Array)
  embeddings.hnsw.json             ← serialized HNSW index for ultra-fast search
```

The index, summaries, and knowledge entries are committed to git so teammates share them. Embeddings are generated locally by each developer from the shared index.

## Installation

```bash
# Inside the vemora/ directory
pnpm install
pnpm build

# Link globally (optional)
pnpm link
```

Or run directly with `node vemora/dist/cli.js` from the project root.

### Installing the alpha version from npm

```bash
pnpm install vemora@alpha     # local
pnpm install -g vemora@alpha  # global

# or with npm:
npm install -g vemora@alpha
```

## The Core Workflow

### 1. Setup (first time only)

```bash
vemora init                  # create .vemora/ and config.json
vemora index --no-embed      # build index without embeddings (fast)
vemora index                 # or: build index + generate embeddings
vemora summarize             # recommended: generate LLM descriptions per file
vemora init-agent            # generate instruction files for AI agents
vemora init-agent --hooks    # also write Claude Code auto-save hooks
```

### 1b. Start of each session

```bash
vemora brief --root .        # compact primer: project overview + critical knowledge
```

### 2. Query during development

```bash
# Search for relevant code
vemora query "how does IMAP reconnect work?"

# Full context block ready to paste into any LLM
vemora context --query "email retry logic" > context.md

# One-shot answer from the configured LLM
vemora ask "why does the sync queue stall?"

# All context about a file or symbol in one call (no LLM needed)
vemora focus src/core/email/services/email.service.ts
vemora focus EmailService.send

# Static scan for bugs/perf/security (no API key required)
vemora triage --type bugs,performance

# Save a finding for future sessions
vemora remember "EmailService.send queues if SMTP is offline — see OutboxRepository"
```

### 3. Complex tasks with the planner-executor pattern

```bash
# Pro LLM plans, small/free LLM executes each step
vemora plan "add rate limiting to the API layer" --confirm --synthesize

# Audit the codebase for issues
vemora audit --type security --root .
vemora audit --since HEAD~1   # only changed files (great for CI)
```

### 4. Keep the index fresh

```bash
vemora index --watch         # incremental re-index on file save
vemora index --no-embed      # after code changes, update structure only
```

## Commands

### `vemora init`

Creates the `.vemora/` folder structure and adds `.vemora-cache/` to `.gitignore`.

```
Options:
  --root <dir>   project root (default: cwd)
```

### `vemora index`

Scans the repo, parses symbols, builds the dependency graph, extracts TODO/FIXME/HACK/XXX annotations, and generates embeddings. **Incremental** — only re-processes files whose SHA-256 hash has changed.

```
Options:
  --root <dir>   project root (default: cwd)
  --force        re-index all files, ignoring hashes
  --no-embed     skip embedding generation (index structure only)
  -w, --watch    watch for changes and re-index automatically
```

### `vemora query "<question>"`

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

#### Output tiers (terminal/markdown)

| Rank | Tier | Content shown |
|------|------|--------------|
| 1–3  | high | Full code block (capped at 30 lines) |
| 4–7  | med  | Declaration signature only |
| 8+   | low  | File path + symbol + score + AI summary |

### `vemora context`

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
  --since <ref>         restrict search to files changed since this git ref (e.g. HEAD~5, main)
```

At least one of `--query` or `--file` is required.

When `--file` is used, the context block also includes:
- **Recent git commits** that touched the file (last 5, via `git log --follow`)
- **TODO/FIXME/HACK/XXX annotations** present in the file
- **Test files** linked to the file — convention-based and import-based discovery
- **Symbol callers** — for each symbol defined in the file, which other project symbols call it

### `vemora ask "<question>"`

One-shot Q&A: retrieves relevant context and calls the configured LLM to answer directly.

```
Options:
  --root <dir>        project root (default: cwd)
  -k, --top-k <n>     chunks to retrieve (default: 5)
  --keyword           use keyword search (no embeddings needed)
  --hybrid            use hybrid vector+BM25 search
  --budget <n>        max context tokens to send to LLM (default: 6000)
  --show-context      print the retrieved context before the answer
```

```bash
vemora ask "how does the IMAP reconnect logic work?" --root .
vemora ask "what does EmailService.send do?" --root . --keyword
```

### `vemora plan "<task>"`

**Planner-executor pattern**: a capable LLM decomposes the task into a structured plan; a smaller/cheaper LLM executes each step against targeted code context.

The planner works from **file summaries and the symbol list** — not raw code — so its token cost stays low regardless of codebase size. The executor receives only the chunks relevant to its specific step (targeted by file/symbol, not just search).

```
Options:
  --root <dir>        project root (default: cwd)
  -k, --top-k <n>     chunks to retrieve per step when falling back to search (default: 5)
  --keyword           use keyword search (no embeddings required)
  --budget <n>        max context tokens per step (default: 4000)
  --confirm           show the plan and ask for confirmation before executing
  --synthesize        call the planner again after all steps to produce a single final answer
  --show-context      print retrieved context for each step
  --verify            after each executor step, have the planner review the output
  --apply             automatically apply unified diffs produced by write steps (via patch -p1)
  --max-retries <n>   max re-runs of a step when verification fails (default: 2)
  --resume <id>       resume a previous session by short ID (first 8 chars) or full UUID
```

#### Step action types

| Action | Behaviour |
|---|---|
| `read` | Pull code into context — no LLM call, zero executor tokens |
| `analyze` | Executor answers a question in prose |
| `write` | Executor produces a unified diff ready to apply |
| `test` | Run a shell command; capture stdout/stderr as step result |

#### Key features

- **Parallel execution** — steps without dependencies run concurrently; sequential steps stream tokens to stdout in real time
- **Step dependencies** (`dependsOn`) — later steps receive prior results as context
- **Context deduplication** — the same file/symbol combination is retrieved only once per session
- **Adaptive re-planning** — if an executor step reports insufficient context (`INSUFFICIENT:`), the planner adds remediation steps automatically
- **Planner verification** (`--verify`) — after each executor step, the planner reviews the output and can request a retry with specific feedback
- **Diff application** (`--apply`) — diffs from `write` steps are applied to the filesystem via `patch -p1`; live file contents are read before write steps to avoid stale index data
- **Session persistence** — every session is saved to `~/.vemora-cache/<projectId>/sessions/` after each wave; interrupted runs can be resumed with `--resume <id>`
- **Save synthesis** — after `--synthesize`, optionally save the result as a knowledge entry

```bash
# Plan, preview, and execute with final synthesis
vemora plan "add batch() method to OpenAIEmbeddingProvider" --confirm --synthesize

# Analysis only (no code changes)
vemora plan "explain how the hybrid search pipeline works" --keyword

# Executor writes diffs, planner verifies each step, apply to disk
vemora plan "fix the N+1 query in UserRepository.findAll" --verify --apply

# Resume an interrupted session (use vemora sessions to find the ID)
vemora plan "..." --resume a1b2c3d4
```

#### Configuration

```json
{
  "planner":  { "provider": "anthropic", "model": "claude-opus-4-6" },
  "executor": { "provider": "ollama",    "model": "qwen2.5-coder:14b",
                "baseUrl": "http://localhost:11434" }
}
```

`executor` is the model that carries out each step. If `executor` is omitted, `summarization` is used as the fallback. If `planner` is omitted, both roles use the same model.

##### Using Claude Code as the planner

Set `provider: "claude-code"` to use the local `claude` CLI subprocess as the planner. The subprocess can autonomously explore the codebase with `Read`, `Grep`, and `Glob` tools before generating the plan:

```json
{
  "planner": {
    "provider": "claude-code",
    "model": "claude-sonnet-4-6",
    "baseUrl": "/path/to/claude",
    "allowedTools": ["Read", "Grep", "Glob"],
    "maxBudgetUsd": 0.50
  }
}
```

`baseUrl` is the path to the `claude` binary (default: `"claude"`, assumed on `PATH`).

### `vemora sessions`

Lists recent plan sessions for the current project, showing their short ID, status, creation date, and task preview.

```bash
vemora sessions --root .
```

Use the short ID printed here with `vemora plan "<task>" --resume <id>` to continue an interrupted run.

### `vemora audit`

Systematic, checklist-driven code audit for **security vulnerabilities**, **performance issues**, and **bugs**. Covers every file in the codebase (or only changed files with `--since`).

```
Options:
  --root <dir>        project root (default: cwd)
  --type <types>      comma-separated: security, performance, bugs (default: all three)
  --since <ref>       only audit files changed since this git ref (e.g. HEAD~5, main)
  --budget <n>        max context tokens per step (default: 5000)
  --keyword           use keyword search (no embeddings required)
  --output <fmt>      terminal (default) | json | markdown
  --save              save critical/high findings as knowledge entries
```

#### Built-in checklists

| Type | Examples |
|---|---|
| `security` | SQL/command/path injection, hardcoded secrets, weak crypto, missing auth/authz, XSS, CSRF, prototype pollution |
| `performance` | N+1 queries, sync I/O in async context, unbounded data loading, memory accumulation, blocking event loop |
| `bugs` | Null dereference, unhandled promise rejections, race conditions, resource leaks, swallowed errors, off-by-one |

#### How it works

1. The **planner** receives the file list + summaries and generates a systematic audit plan, grouping 2-5 related files per step with specific checklist items.
2. Steps execute in **parallel waves of 3** — the executor returns structured JSON findings for each group.
3. Findings are **deduplicated, sorted by severity**, and displayed as a report.
4. `--save` persists critical/high findings to the knowledge store for future sessions.

```bash
# Full audit
vemora audit --root .

# Security only
vemora audit --type security --root .

# Audit only what changed in the last commit (ideal for CI/CD)
vemora audit --since HEAD~1 --root .

# Audit changes vs main branch, save findings
vemora audit --since main --type security,bugs --save --root .

# Export for a PR review
vemora audit --since main --output markdown --root . > audit-report.md
```

#### Example output

```
── Audit Report [security] ─────────────────────────────
   12 file(s) analysed · 3 finding(s)

[CRITICAL] Injection  src/api/users.ts:89
  User input concatenated directly into SQL query without parameterization.
  → Use parameterized queries or a query builder.

[HIGH] Hardcoded Secret  src/config.ts:12
  API key hardcoded in source — will be exposed in version control.
  → Move to environment variables and rotate the key.

[MEDIUM] Missing Authorization  src/api/admin.ts:34
  Admin endpoint does not verify that the caller has the admin role.
  → Add role check before processing the request.

─────────────────────────────────────────────────────────
  1 critical · 1 high · 1 medium
```

### `vemora remember "<text>"`

Saves a persistent knowledge entry to `.vemora/knowledge/entries.json`. The entry is committed to git and included automatically in future `context` and `ask` results when relevant.

When `--category` is omitted, the configured LLM classifies the entry automatically into one of the four categories. Falls back to `pattern` if no LLM is available.

```
Options:
  --root <dir>            project root (default: cwd)
  --category <cat>        decision | pattern | gotcha | glossary (auto-classified if omitted)
  --files <paths>         comma-separated related file paths
  --symbols <names>       comma-separated related symbol names
  --confidence <level>    high | medium | low (default: medium)
```

```bash
# Category auto-classified by the LLM
vemora remember "EmailService.send queues if SMTP offline — see OutboxRepository"

# Or specify explicitly
vemora remember "EmailService.send queues if SMTP offline — see OutboxRepository" \
  --category gotcha \
  --files src/core/email/services/email.service.ts \
  --symbols EmailService.send
```

### `vemora brief`

Prints a compact session primer — project overview and high-confidence knowledge entries — designed to be run at the start of each LLM session to re-establish context with minimal tokens.

```
Options:
  --root <dir>   project root (default: cwd)
  --all          include all knowledge entries, not only high-confidence ones
```

```bash
vemora brief --root .       # overview + high-confidence entries only (~170 tokens)
vemora brief --root . --all # include all entries
```

### `vemora knowledge`

Manages saved knowledge entries.

```bash
vemora knowledge list --root .          # list all entries grouped by category
vemora knowledge forget <id> --root .   # remove an entry by ID (prefix match)
```

### `vemora init-agent`

Generates AI agent instruction files from the existing index. Supports Claude Code, Gemini, GitHub Copilot, Cursor, and Windsurf.

```
Options:
  --root <dir>     project root (default: cwd)
  --agent <name>   target a single agent: claude, gemini, copilot, cursor, windsurf (default: all)
  --force          overwrite existing files that have no vemora markers
  --hooks          write Claude Code hooks to .claude/settings.json (claude target only)
```

Use `--hooks` to register a `PreCompact` hook that reminds Claude Code to persist key decisions before context is compressed:

```bash
vemora init-agent --agent claude --hooks --root .
```

| Agent | Output file |
|---|---|
| `claude` | `CLAUDE.md` |
| `gemini` | `GEMINI.md` |
| `copilot` | `.github/copilot-instructions.md` |
| `cursor` | `.cursor/rules/vemora.mdc` (with `alwaysApply: true`) |
| `windsurf` | `.windsurfrules` |

Re-running `init-agent` only updates the auto-generated block between `<!-- vemora:generated:start/end -->` markers. Custom content outside the markers is preserved.

### `vemora summarize`

Generates LLM-powered summaries for every indexed file and a high-level project overview. **Incremental** — only re-generates summaries for files whose content has changed.

Summaries are used by `vemora plan` and `vemora audit` as cheap planner context (instead of raw code chunks).

```
Options:
  --root <dir>       project root (default: cwd)
  --force            re-generate all summaries
  --model <name>     override LLM model (default: from config)
  --files-only       only generate per-file summaries
  --project-only     (re)generate project overview from existing file summaries
  --show             print the existing project overview without regenerating
```

```bash
vemora summarize --show --root .   # print overview without regenerating
```

### `vemora status`

Prints index stats, embedding cache info, knowledge store summary, and a count of TODO/FIXME/HACK/XXX annotations by type.

### `vemora deps <file>`

Shows the full dependency context for a file: what it imports, what imports it.

```
Options:
  --root <dir>            project root (default: cwd)
  -d, --depth <n>         transitive depth for outgoing imports (default: 1)
  -r, --reverse-depth <n> transitive depth for incoming importers (default: 1)
```

```bash
# All files that depend on SyncOrchestrator, up to 3 hops
vemora deps src/core/sync/SyncOrchestrator.ts --root . --reverse-depth 3
```

### `vemora usages <SymbolName>`

Finds all files that use a named symbol, following re-export chains.

```
Options:
  --root <dir>          project root (default: cwd)
  -d, --depth <n>       max re-export chain depth to follow (default: 10)
  --callers-only        show only files with call graph data
```

### `vemora chat`

Interactive chat session with the codebase. Supports OpenAI, Anthropic, Gemini, and Ollama.

```bash
vemora chat --provider anthropic --model claude-opus-4-6
vemora chat --provider ollama --model qwen2.5-coder:14b
```

### `vemora report`

Shows a usage statistics report: commands breakdown, token savings, and most frequent query terms.

```
Options:
  --root <dir>   project root (default: cwd)
  --days <n>     limit report to events from the last N days
  -v, --verbose  show per-query breakdown (last 20 queries)
  --clear        clear all recorded usage data
```

### `vemora triage`

Zero-LLM static heuristic scan for bugs, security issues, and performance problems. Works entirely from the existing index — no API key or network access required.

```
Options:
  --root <dir>        project root (default: cwd)
  --type <types>      comma-separated: bugs, security, performance (default: all)
  -k, --top-k <n>     max findings to return, ranked by score (default: 30)
  --min-score <n>     skip findings below this threshold (default: 1)
  --file <path>       restrict scan to files matching this substring
  --output <fmt>      terminal (default) | json | markdown
```

Each finding includes a severity (high/medium/low), a reason, and the exact code location.

```bash
# Full scan
vemora triage --root .

# Bugs only, top 10, export to Markdown
vemora triage --type bugs -k 10 --output markdown --root .

# Security scan limited to the API layer
vemora triage --type security --file src/api --root .
```

Heuristics cover: empty catch blocks, unguarded `JSON.parse`, sync I/O in loops, `any` casts, hardcoded secrets, dangerous `eval`/`exec`, prototype pollution, SQL/command injection patterns, and more.

### `vemora dead-code`

Zero-LLM static analysis for unused code. Works entirely from the existing index — no API key or network access required.

```
Options:
  --root <dir>        project root (default: cwd)
  --type <types>      comma-separated: uncalled-private, unused-export, unreachable-file (default: all)
  --output <fmt>      terminal (default) | json
```

Three detection categories:

| Type | What it finds |
|---|---|
| `uncalled-private` | Private functions and methods with an entry in the call graph but no recorded callers |
| `unused-export` | Exported symbols not imported by any file in the dep graph (namespace imports excluded) |
| `unreachable-file` | Files that export symbols but are never imported by any other file in the project |

```bash
# Full scan — all three categories
vemora dead-code --root .

# Only private methods with no callers
vemora dead-code --type uncalled-private --root .

# Machine-readable output
vemora dead-code --output json --root . | jq '.[] | select(.type == "unused-export")'
```

**Caveats:** call graph coverage is incomplete for dynamic dispatch, arrow functions assigned to variables, and `require()` calls. Namespace imports (`import * as X`) prevent false positives on `unused-export` by marking the whole file as used. Entry points (`cli.ts`, `index.ts`, `main.ts`, etc.) are excluded from `unreachable-file`.

### `vemora focus <target>`

Aggregates all structural context about a file or symbol in one call — replaces the need to run `context`, `deps`, `usages`, and `knowledge` separately.

```
Options:
  --root <dir>      project root (default: cwd)
  --format <fmt>    markdown (default) | plain
```

`<target>` can be a file path (full or partial) or a symbol name:

```bash
# File focus — exports, chunks, imports, importers, call graph, tests, knowledge
vemora focus src/core/email/services/email.service.ts --root .
vemora focus email.service --root .   # partial path match

# Symbol focus — implementation, callers, callees, sibling members, tests
vemora focus EmailService.send --root .

# Pipe into a context block for any LLM
vemora focus src/search/hybrid.ts --root . --format plain > context.md
```

---

## Configuration

Edit `.vemora/config.json` after `init`:

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
    "provider": "ollama",
    "model": "nomic-embed-text",
    "dimensions": 768
  },
  "summarization": {
    "provider": "ollama",
    "model": "gemma4:e2b",
    "baseUrl": "http://localhost:11434"
  },
  "reranker": {
    "provider": "ollama"
  },
  "display": {
    "format": "terse"
  }
}
```

### Planner-executor configuration

Add `planner` and `executor` blocks to use different models for planning and execution:

```json
{
  "planner": {
    "provider": "anthropic",
    "model": "claude-opus-4-6"
  },
  "executor": {
    "provider": "gemini",
    "model": "gemini-2.0-flash",
    "apiKey": "your-google-ai-studio-key"
  }
}
```

`planner` is used by `vemora plan` and `vemora audit`. `executor` handles step execution. Fallback chain: `executor` → `summarization` → same model for both roles.

The `planner` config also accepts two extra fields when using `claude-code`:

| Field | Type | Description |
|---|---|---|
| `allowedTools` | `string[]` | Tools the subprocess may call (default: `["Read","Grep","Glob"]`) |
| `maxBudgetUsd` | `number` | Spend cap per plan call in USD (default: `0.50`) |

### `display.format`

Sets the default output format for `query`, `context`, and `ask`. Set to `"terse"` for small/local models with limited context windows.

### Embedding providers

| Provider | Config | Notes |
|---|---|---|
| `openai` | `OPENAI_API_KEY` env or `apiKey` in config | Best quality. Requires `npm install openai`. |
| `ollama` | `baseUrl`, `maxChars` (see below) | Local, no cost. |
| `none` | — | Keyword search only, no embeddings. |

#### Ollama embedding options

| Field | Default | Description |
|---|---|---|
| `model` | `"nomic-embed-text"` | Embedding model to pull and use |
| `dimensions` | `768` | Must match the model output dimensions |
| `baseUrl` | `"http://localhost:11434"` | Ollama server URL |
| `maxChars` | `3800` | Max characters per chunk before truncation. Prevents exceeding the model's context window. Increase for models with larger context (e.g. `mxbai-embed-large`: ~8000). |

```json
"embedding": {
  "provider": "ollama",
  "model": "nomic-embed-text",
  "dimensions": 768,
  "maxChars": 3800
}
```

### LLM providers

Used by `ask`, `chat`, `summarize`, `plan`, and `audit`.

| Provider | Config | Notes |
|---|---|---|
| `openai` | `OPENAI_API_KEY` env or `apiKey` in config | Also works with any OpenAI-compatible endpoint via `baseUrl`. |
| `anthropic` | `ANTHROPIC_API_KEY` env or `apiKey` in config | Requires `npm install @anthropic-ai/sdk`. |
| `gemini` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` env or `apiKey` in config | Uses Google's OpenAI-compatible endpoint. Free tier available via Google AI Studio. |
| `ollama` | `baseUrl` (default: `http://localhost:11434`) | Local, no cost. |
| `claude-code` | `baseUrl` = path to `claude` binary (default: `"claude"`) | Planner-only. Spawns the Claude Code CLI subprocess; the subprocess can explore the codebase with `Read`/`Grep`/`Glob` before answering. Requires Claude Code installed and authenticated. |

#### OpenAI-compatible endpoints

The `openai` provider accepts a `baseUrl` field, enabling any compatible API:

```json
{ "provider": "openai", "model": "llama-3.3-70b-versatile", "baseUrl": "https://api.groq.com/openai/v1", "apiKey": "..." }
```

| Service | `baseUrl` | Free tier |
|---|---|---|
| Groq | `https://api.groq.com/openai/v1` | Yes (rate limited) |
| OpenRouter | `https://openrouter.ai/api/v1` | Some free models |
| Gemini (compat) | `https://generativelanguage.googleapis.com/v1beta/openai/` | Yes |

### Reranker

Controls how search results are re-scored when `--rerank` is passed to `query`, `context`, or `ask`, and always in `chat`.

| Provider | Config | Notes |
|---|---|---|
| `xenova` | _(no extra config)_ | Local cross-encoder (`ms-marco-MiniLM-L-6-v2`). Best quality. Requires `npm install @xenova/transformers`. |
| `ollama` | `model` (optional), `baseUrl` (optional) | Uses the configured LLM to rank results in a single call. No extra dependency. |
| `none` | — | Skip reranking entirely. |

```json
{
  "reranker": { "provider": "ollama" }
}
```

When `provider` is `ollama` and `model` is omitted, the model from `summarization` is used.

### Recommended configurations

**Maximum quality (cloud)**
```json
{
  "planner":  { "provider": "anthropic", "model": "claude-opus-4-6" },
  "executor": { "provider": "openai",    "model": "gpt-4o-mini" }
}
```

**Claude Code as planner + free executor**
```json
{
  "planner":  { "provider": "claude-code", "model": "claude-sonnet-4-6",
                "allowedTools": ["Read","Grep","Glob"], "maxBudgetUsd": 0.50 },
  "executor": { "provider": "ollama", "model": "qwen2.5-coder:14b",
                "baseUrl": "http://localhost:11434" }
}
```

**Pro planner + free executor**
```json
{
  "planner":  { "provider": "anthropic", "model": "claude-opus-4-6" },
  "executor": { "provider": "gemini",    "model": "gemini-2.0-flash", "apiKey": "..." }
}
```

**Fully local (no API keys)**
```json
{
  "embedding":     { "provider": "ollama", "model": "nomic-embed-text", "dimensions": 768 },
  "summarization": { "provider": "ollama", "model": "gemma4:e2b" },
  "executor":      { "provider": "ollama", "model": "qwen2.5-coder:7b" },
  "reranker":      { "provider": "ollama" },
  "display":       { "format": "terse" }
}
```

Other local executor models that work well: `qwen2.5-coder:14b`, `llama3.2`, `mistral`.

---

## What goes in git

```
✓ .vemora/config.json
✓ .vemora/metadata.json
✓ .vemora/index/files.json
✓ .vemora/index/chunks.json
✓ .vemora/index/symbols.json
✓ .vemora/index/deps.json
✓ .vemora/index/callgraph.json
✓ .vemora/summaries/file-summaries.json
✓ .vemora/summaries/project-summary.json
✓ .vemora/knowledge/entries.json    ← shared knowledge store

✗ .vemora-cache/                    ← local embedding vectors (gitignored)
```

## Incremental indexing

Chunk IDs are derived from `sha256(filePath + content)`. If a function's code doesn't change, its chunk ID is stable across branches — embeddings are reused without any API call.

## Tech stack

- **TypeScript + Node.js** (CommonJS, ES2022 target)
- **commander** — CLI framework
- **fast-glob** — repository scanning
- **tree-sitter** (optional) — AST-based symbol extraction for TS/JS
- **openai** SDK _(optional)_ — embedding generation, OpenAI and Gemini LLM provider; `npm install openai`
- **@anthropic-ai/sdk** _(optional)_ — Anthropic/Claude LLM provider; `npm install @anthropic-ai/sdk`
- **@xenova/transformers** _(optional)_ — local cross-encoder model for `--rerank` with `reranker.provider = "xenova"`; `npm install @xenova/transformers`. Not needed if using `reranker.provider = "ollama"` or `"none"`.
- **hnsw** — HNSW index for sub-millisecond vector search
- **chokidar** — file watching for `--watch` mode
- **chalk + ora** — terminal output

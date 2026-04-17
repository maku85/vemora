## Working with this codebase

- **Before reading any file**, check the Key Exports table to locate the symbol.
- **Before querying**, try `vemora query` first — open a file only if context is insufficient.
- **Before deep-diving a file or symbol**, use `vemora focus` — aggregates impl, deps, callers, tests, and knowledge in one call.
- **Before modifying a file**, check blast radius: `vemora deps <file> --root . --reverse-depth 2`.
- **Before renaming a symbol**, check callers: `vemora usages <SymbolName> --root .` (add `--callers-only` for methods).
- **After changes**, run the build/test command before declaring done.
- **Scope discipline**: only change what was asked. No refactoring, comments, or improvements beyond the request.
- **Save non-obvious findings** with `vemora remember` — decisions, gotchas, patterns. Skip what's obvious from reading the code.

## Session setup

```bash
vemora brief --root .          # start of session: project overview + knowledge entries
vemora index --root . --watch  # background terminal: live re-index on file save
vemora index --root . --no-embed  # or: re-index manually after significant changes
```

## Quick reference

| Need | Command |
|---|---|
| Session start | `brief --root .` |
| Session start (task-specific) | `brief --root . --skill debug\|refactor\|add-feature\|security\|explain\|test` |
| File or symbol deep-dive | `focus <target> --root .` |
| Deep-dive restricted to lines | `focus <target> --root . --lines <start>-<end>` |
| Concept / how-does-X question | `context --root . --query "<question>"` |
| Fix / refactor / add code | `context --root . --query "<task>" --keyword` |
| Debug an error (skill preset) | `context --root . --query "<error>" --skill debug` |
| Refactor safely (skill preset) | `context --root . --query "<target>" --skill refactor` |
| Add new feature (skill preset) | `context --root . --query "<feature>" --skill add-feature` |
| Scope to recent changes | `context --root . --query "..." --since HEAD~5` |
| Complex multi-step task | `plan "<task>" --root . --confirm --synthesize` |
| LLM audit (security/bugs/perf) | `audit --root . --type security,bugs` |
| Zero-LLM static scan | `triage --root . --type bugs,security` |
| Find unused code | `dead-code --root .` |
| Output too long | add `--budget 2000` to any command |
| No embeddings / fast search | add `--keyword` to `query` or `context` |
| Who imports a file | `deps <file> --root .` |
| Blast radius of a change | `deps <file> --root . --reverse-depth 3` |
| Who uses a symbol | `usages <SymbolName> --root .` |
| Who calls a method | `usages <Method> --root . --callers-only` |
| Save a finding | `remember "text" --root .` |


<!-- vemora:generated:start -->

## Project Overview

The vemora codebase is a local RAG system designed to pre-index a codebase into a structured format, enabling semantic search over it. The main architectural layers include:

* **EmbeddingProvider**: A key export responsible for loading and managing embeddings from an OpenAI model.
* **Indexer**: Responsible for building and maintaining the index of a project's codebase, including scanning, hashing, parsing, and building dependencies.

Key data flows include:

* **Code ingestion**: The indexer scans the codebase, hashes files, and builds dependencies to create a structured index.
* **Embedding generation**: The EmbeddingProvider generates embeddings from input texts in batches using the OpenAI API or local models like Ollama.
* **Query execution**: The query command executes queries on the indexed data, returning relevant results.

Entry points for development tasks include:

* **src/cli.ts**: The entry point for the vemora CLI tool, defining commands for initializing and indexing a codebase, as well as querying it for relevant code snippets.
* **src/commands/index.ts**: Responsible for building and maintaining the index of a project's codebase.
* **src/embeddings/factory.ts**: A factory that instantiates the correct EmbeddingProvider based on the provided configuration.

The vemora codebase uses various dependencies, including OpenAI models, Ollama, and Sharp. The package.json file defines dependencies, scripts, and metadata for the project. The pnpm-workspace.yaml file configures dependencies for a workspace, specifying which built-in dependencies to ignore and only build the Sharp library.

Known issues in the vemora codebase include:

* Unvalidated JSON parsing
* Path alias resolution allowing root escape
* Implicit trust of optional dependencies through dynamic require()

The development guide is documented in docs/development.md, covering how to extend the vemora tool and its planned roadmap. The features-planned file implements two planned features: Complexity heuristics and Coverage integration.

Overall, the vemora codebase provides a robust architecture for pre-indexing a codebase into a structured format, enabling semantic search over it. Its modular design allows for easy extension and customization of embedding providers and indexing functionality.

## Commands

```bash
npm run build            # tsc
npm run build:watch      # tsc --watch
npm run dev              # ts-node src/cli.ts
npm run clean            # rimraf dist
npm run format           # biome format --write src/
npm run lint             # biome check src/
npm run lint:fix         # biome check --write src/
npm run prepublishOnly   # npm run build
npm run release          # node scripts/release.js
```

## Entry Points

- `src/cli.ts` — This file, `src/cli.ts`, is the entry point for the vemora CLI tool. It defines a set of commands for initializing and indexing a codebase, as well as querying it for relevant code snippets. Key exports include AgentTarget, AuditType, and TriageType, which are used in various command implementations.

## Key Exports

| Symbol | Type | File |
|---|---|---|
| `AnthropicProvider` | class | `src/llm/anthropic.ts` |
| `ClaudeCodeProvider` | class | `src/llm/claude-code.ts` |
| `EmbeddingCacheStorage` | class | `src/storage/cache.ts` |
| `KnowledgeStorage` | class | `src/storage/knowledge.ts` |
| `NoopEmbeddingProvider` | class | `src/embeddings/noop.ts` |
| `OllamaEmbeddingProvider` | class | `src/embeddings/ollama.ts` |
| `OllamaProvider` | class | `src/llm/ollama.ts` |
| `OpenAIEmbeddingProvider` | class | `src/embeddings/openai.ts` |
| `OpenAIProvider` | class | `src/llm/openai.ts` |
| `PlanSessionStorage` | class | `src/storage/planSession.ts` |
| `RepositoryStorage` | class | `src/storage/repository.ts` |
| `SessionStorage` | class | `src/storage/session.ts` |
| `SummaryStorage` | class | `src/storage/summaries.ts` |
| `UsageStorage` | class | `src/storage/usage.ts` |
| `applyMMR` | function | `src/search/mmr.ts` |
| `applySkill` | function | `src/skills/index.ts` |
| `applyTokenBudget` | function | `src/utils/tokenizer.ts` |
| `buildClassHeaders` | function | `src/indexer/classHeader.ts` |
| `buildGeneratedBlock` | function | `src/commands/init-agent.ts` |
| `buildGlobalCallGraph` | function | `src/indexer/callgraph.ts` |
| `buildSymbolIndex` | function | `src/indexer/parser.ts` |
| `chunkBySlidingWindow` | function | `src/indexer/chunkBySlidingWindow.ts` |
| `chunkBySymbols` | function | `src/indexer/chunkBySymbols.ts` |
| `chunkFile` | function | `src/indexer/chunker.ts` |
| `computeBM25Scores` | function | `src/search/bm25.ts` |
| `computeImportedBy` | function | `src/indexer/deps.ts` |
| `cosineSimilarity` | function | `src/search/vector.ts` |
| `cosineSimilarityBinary` | function | `src/search/vector.ts` |
| `countTokensHeuristic` | function | `src/utils/tokenizer.ts` |
| `createEmbeddingProvider` | function | `src/embeddings/factory.ts` |
| `createLLMProvider` | function | `src/llm/factory.ts` |
| `deduplicateBySimilarity` | function | `src/search/merge.ts` |
| `detectCycles` | function | `src/indexer/deps.ts` |
| `detectNpmScripts` | function | `src/commands/init-agent.ts` |
| `extractFileCalls` | function | `src/indexer/callgraph.ts` |
| `extractFileImports` | function | `src/indexer/deps.ts` |
| `extractSignature` | function | `src/search/signature.ts` |
| `extractTodos` | function | `src/indexer/todos.ts` |
| `filterValidAt` | function | `src/storage/knowledge.ts` |
| `findTestFiles` | function | `src/indexer/tests.ts` |

_Generated by `vemora init-agent` — 2026-04-17T20:41:51.097Z_

<!-- vemora:generated:end -->

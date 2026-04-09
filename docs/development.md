# vemora — Development Guide

This document covers how to extend the tool, known limitations, and the planned roadmap. It is intended for developers and LLM agents continuing work on `vemora`.

---

## Development setup

```bash
cd vemora/
npm install
npm run build          # compiles to dist/
npm run build:watch    # watch mode for active development

# Run directly without building:
npx ts-node src/cli.ts init --root ..
npx ts-node src/cli.ts index --root .. --no-embed
npx ts-node src/cli.ts query "authentication" --root .. --keyword
```
---

## Local model configuration (Ollama)

`vemora` works fully offline with [Ollama](https://ollama.com). No API keys required.

### Install and pull models

```bash
# Install Ollama from https://ollama.com, then:
ollama pull nomic-embed-text      # 274 MB — embeddings
ollama pull qwen2.5-coder:14b     # ~9 GB — recommended for 16 GB RAM
# Lighter alternatives:
ollama pull qwen2.5-coder:7b      # ~4.7 GB
ollama pull codellama:7b          # ~3.8 GB
```

### Configure `.vemora/config.json`

Run `vemora init --root .` first, then edit the generated config:

```json
{
  "embeddings": {
    "provider": "ollama",
    "model": "nomic-embed-text",
    "baseUrl": "http://localhost:11434",
    "dimensions": 768
  },
  "summarization": {
    "provider": "ollama",
    "model": "qwen2.5-coder:14b",
    "baseUrl": "http://localhost:11434"
  }
}
```

### Index and query

```bash
# Index with local embeddings (Ollama must be running)
node dist/cli.js index --root .

# Keyword-only mode (no embeddings needed at all)
node dist/cli.js index --root . --no-embed
node dist/cli.js query "authentication" --root . --keyword
```

### Performance notes

| Model | RAM usage | Speed (M2 Pro) | Quality |
|---|---|---|---|
| `nomic-embed-text` | ~500 MB | ~200 chunks/s | Good |
| `qwen2.5-coder:7b` | ~5 GB | ~20 tok/s | Good |
| `qwen2.5-coder:14b` | ~9 GB | ~10 tok/s | Very good |

For query and context commands (`vemora query`, `vemora context`), the LLM is not called — results come from the local index. The LLM is used only by `vemora chat` and `vemora summarize`.

---

## How to add a new embedding provider

1. Create `src/embeddings/<name>.ts` implementing `EmbeddingProvider`:

```typescript
import type { EmbeddingProvider } from './provider';

export class MyProvider implements EmbeddingProvider {
  readonly name = 'myprovider';
  readonly model: string;
  readonly dimensions: number;

  constructor(/* config options */) { ... }

  async embed(texts: string[]): Promise<number[][]> {
    // return one number[] per input text
  }
}
```

2. Add a case in `src/embeddings/factory.ts`:

```typescript
case 'myprovider':
  return new MyProvider(config.model, config.baseUrl, config.dimensions);
```

3. Extend `EmbeddingConfig.provider` type in `src/core/types.ts`:

```typescript
provider: 'openai' | 'ollama' | 'none' | 'myprovider';
```

That's all. No other changes needed.

---

## How to add support for a new language

The parser in `src/indexer/parser.ts` has two extension points:

### Adding tree-sitter grammar

1. Install the grammar: `npm install tree-sitter-python` (optional dep)
2. In `parser.ts`, add to the try/catch block at the top:
   ```typescript
   let pythonLanguage: unknown = null;
   try {
     pythonLanguage = require('tree-sitter-python');
   } catch {}
   ```
3. In `parseSymbols()`, add a case before the regex fallback:
   ```typescript
   if (ext === 'py') return parseWithTreeSitter(content, pythonLanguage);
   ```
4. Extend `visitNode()` for Python AST node types:
   - `function_definition` → function
   - `class_definition` → class
   - `decorated_definition` → check inner node type

### Extending the regex fallback

Add a new pattern to the `patterns` array in `parseWithRegex()`:

```typescript
{ re: /^(pub\s+)?enum\s+(\w+)/, type: 'class' },
```

Order matters: first matching pattern wins per line.

---

## How to add a new CLI command

1. Create `src/commands/<name>.ts` with an exported `run<Name>` async function
2. Import and register in `src/cli.ts`:
   ```typescript
   import { runName } from './commands/name';
   program.command('name <arg>').option(...).action(async (arg, opts) => { ... });
   ```

---

## Known limitations

### Dynamic import strings
`import(\`${variable}\`)` (template literals) are not resolved. Only string literal dynamic imports are tracked.

---

## Planned improvements

Candidates for future implementation, ordered by priority.

### 1. Tiered display per relevance score

**Goal:** reduce token usage by showing less code when the chunk is only marginally relevant.

**File:** `src/search/signature.ts`, `src/commands/query.ts`

Currently tiers are based on rank position (1–3 = full, 4–7 = signature, 8+ = summary). Change to absolute relevance score thresholds:

```
score ≥ 0.90 → full code (max 30 lines)
score ≥ 0.75 → full code (max 15 lines)
score ≥ 0.55 → signature only
score  < 0.55 → file + symbol + score only
```

Thresholds should be configurable in `config.json` under `display.tiers`. Estimated savings: **20–35% tokens** on generic queries.

---

### 2. Diff-aware context for modification queries

**Goal:** when the query signals a modification task, automatically surface related tests and the public interface being modified.

**File:** `src/commands/context.ts`

```typescript
const isModificationQuery = /\b(fix|refactor|change|add|update|remove|rename)\b/i.test(query);
if (isModificationQuery) {
  // 1. include top chunk in full
  // 2. find test files via findTestFiles() (already implemented)
  // 3. include the interface/type chunks the symbol implements
}
```

Prevents the LLM from breaking existing contracts during modifications. `findTestFiles()` is already available; the missing piece is the interface/type lookup and the intent detection.

---

### 3. Suggested next command

**Goal:** guide small/local models to the next step without requiring agentive reasoning.

**File:** `src/commands/query.ts`, `src/commands/context.ts`

Append a "Suggested next step:" block at the end of every response:

```markdown
---
Suggested next step:
node vemora/dist/cli.js context --root . --file src/core/email/services/email.service.ts
```

Suggestion logic: top score > 0.85 → suggest `context --file <top_file>`; 0.6–0.85 → suggest `context --query` with a narrower term; keyword-only → suggest enabling embeddings.

---

### 4. Git-aware score boost

**Goal:** surface files touched recently as higher-priority results, without changing the query.

**File:** `src/commands/context.ts`, `src/commands/query.ts`

```typescript
// git diff HEAD~3 --name-only → set of recently changed files
const recentFiles = new Set(getRecentlyChangedFiles(rootDir));
results = results.map(r => ({
  ...r,
  score: recentFiles.has(r.chunk.file) ? r.score * 1.3 : r.score,
})).sort((a, b) => b.score - a.score);
```

`getFileGitHistory()` is already available in `src/utils/git.ts`; extend it to return the set of files changed in recent commits.

---

## EXPERIMENTAL — direzioni non-standard

Queste non sono ottimizzazioni incrementali del pipeline RAG esistente, ma cambi di paradigma. Nessuna è uno standard consolidato oggi. Alcune potrebbero diventare best practice nei prossimi anni.

---

### E1. Memoria bidirezionale — l'LLM scrive nel knowledge store

**Problema:** oggi il knowledge store è write-only da parte dell'utente (`vemora remember`). L'LLM non può scrivere nulla senza intervento umano esplicito.

**Idea:** dopo ogni sessione `chat` o `ask`, analizzare la conversazione e proporre nuovi `KnowledgeEntry` in modo autonomo:

```typescript
// Alla fine di vemora chat:
const proposed = await llm.extractKnowledge(conversationHistory);
for (const entry of proposed) {
  console.log(`\nProposed knowledge entry:\n${entry.title}: ${entry.body}`);
  const confirmed = await prompt("Save? [y/n]");
  if (confirmed === "y") knowledgeStorage.add(entry);
}
```

**Pattern di estrazione da cercare:**
- "This works because..." → `decision`
- "Watch out for..." / "Bug:" → `gotcha`
- "The pattern here is..." → `pattern`
- "X is Y" (definizione) → `glossary`

**Direzione più estrema:** write automatico senza conferma, con confidence bassa taggata come `llm:auto`. L'utente può revisionare con `vemora knowledge list`.

**Rischio:** noise se l'LLM fa inferenze sbagliate. Mitigabile con confidence threshold e revisione periodica.

---

### E2. Retrieval uncertainty-aware — superficia la fiducia del retrieval all'LLM

**Problema:** l'LLM riceve i chunk come se fossero tutti ugualmente rilevanti. Non sa se il contesto è solido o marginalmente correlato. Questo porta a risposte confident su contesto debole.

**Idea:** includere nel prompt un indicatore esplicito di confidence del retrieval:

```markdown
## Retrieved Context
[Retrieval confidence: HIGH — top score 0.94, 3 chunks > 0.85]

## Retrieved Context
[Retrieval confidence: LOW — best match 0.52, results may be weakly related]
If context seems insufficient, say so before answering.
```

**Implementazione:** aggiungere in `generateContextString()` un header basato sulle statistiche dei score:

```typescript
const maxScore = results[0]?.score ?? 0;
const highCount = results.filter(r => r.score > 0.85).length;
const confidence = maxScore > 0.85 ? "HIGH" : maxScore > 0.65 ? "MEDIUM" : "LOW";
lines.push(`[Retrieval confidence: ${confidence} — top score ${maxScore.toFixed(2)}, ${highCount} chunks above 0.85]`);
```

**Beneficio:** l'LLM modella meglio l'incertezza. Riduce le allucinazioni confident su contesto insufficiente.

---

### E3. Semantic drift detection — monitora l'evoluzione semantica del codice

**Problema:** quando una funzione cambia significato (non solo firma), l'embedding vecchio non è più valido. Ma l'hash del contenuto cambia, quindi l'embedding viene ricalcolato — questo è già gestito. Il problema più sottile è a livello di *architettura*: la funzione viene ancora trovata dalle stesse query di prima, ma ora fa qualcosa di diverso.

**Idea:** al momento del re-index, confrontare il nuovo embedding con il vecchio e segnalare le funzioni il cui significato semantico è cambiato più del previsto:

```typescript
const drift = 1 - cosineSimilarity(oldEmbedding, newEmbedding);
if (drift > 0.3) {
  driftLog.push({ file, symbol, drift, changedAt: new Date().toISOString() });
}
```

Salvare in `.vemora/drift-log.json`. `vemora status` potrebbe mostrare le funzioni con drift elevato.

**Caso d'uso concreto:** refactor silenziosi dove la firma non cambia ma il comportamento sì. Il drift log diventa un changelog semantico, non sintattico.

---

### E4. Intent-based routing delle query

**Problema:** tutte le query seguono lo stesso pipeline (embed → search → format). Ma una query di debug, una di spiegazione e una di modifica hanno esigenze di contesto molto diverse.

**Idea:** classificare l'intent della query prima del retrieval e adattare la strategia:

```
debug    → priorità a file con test + recenti commit + error handler
explain  → priorità a file entry-point + dipendenze transitive
modify   → priorità a interfacce pubbliche + test esistenti + chiamanti
review   → priorità a file più complessi + code smell patterns
```

**Implementazione opzioni:**
1. **Regex heuristic** (zero costo): `/\b(fix|bug|error|crash)\b/i` → debug mode
2. **Piccolo classificatore locale** (4 classi, ~10 MB): eseguito offline, latenza < 50ms
3. **Primo token LLM** (con provider configurato): `Classify as debug|explain|modify|review: "${query}"`

La logica di routing va in `src/commands/context.ts` come pre-step, prima del retrieval.

---

### E5. Working memory cross-sessione — blackboard multi-agente

**Problema:** ogni sessione parte da zero. Se un agente ha già esplorato `EmailService.send` e capito che è il collo di bottiglia, la sessione successiva non lo sa.

**Idea:** un file di working memory locale (fuori da git, in `~/.vemora-cache/<projectId>/working-memory.json`) che accumula:

```json
{
  "explored": ["src/core/email/services/email.service.ts"],
  "hypotheses": ["bottleneck is in OutboxRepository.flush()"],
  "open_questions": ["why does sync stall on large attachments?"],
  "session_notes": [{ "ts": "...", "note": "..." }]
}
```

L'agente può leggere e scrivere questo file con comandi dedicati:

```bash
vemora memory show           # mostra lo stato corrente
vemora memory note "..."     # aggiunge una nota
vemora memory clear          # reset
```

**Uso multi-agente:** se più sessioni condividono lo stesso cache dir (es. più terminali sullo stesso progetto), il blackboard diventa uno spazio condiviso. Potenzialmente utile per workflow con `claude --continue` o task lunghi.

---

### E6. Speculative chunking — indicizza ipotesi sul codice non ancora scritto

**Problema:** il codice non esiste finché non è scritto, ma durante un task di sviluppo l'LLM deve ragionare su dove mettere nuove funzioni, come integrarle, che interface seguire.

**Idea:** al momento del task (non dell'index), generare chunk ipotetici che descrivono il codice che *dovrebbe* esistere, ed embeddarli per trovare il contesto più vicino:

```typescript
// Prima del retrieval, per query di tipo "add":
const hypotheticalCode = await llm.generateHypothetical(query);
// "A function that validates SmtpConfig before connecting..."
const [hypEmbedding] = await provider.embed([hypotheticalCode]);
results = vectorSearch(hypEmbedding, chunks, cache, symbols, topK);
```

Questo è **HyDE (Hypothetical Document Embeddings)** applicato al codice. Il risultato pratico: trova il contesto strutturalmente più simile a ciò che l'LLM sta per scrivere, non solo semanticamente simile alla query testuale.

**Costo:** un'extra LLM call per query di tipo "add/create/implement". Aggirabile con cache del chunk ipotetico per query simili.

---

### Nota aperta: il problema della densità informativa
### Open note: the problem of information density

None of the above improvements solve the fundamental problem: **there is no objective metric for "how much context is enough"**. Token budgets are imprecise proxies; relevance scores are approximations; display tiers are heuristics.

Active research in this area (2024-2025) explores:
- **Adaptive context windows**: the model explicitly requests more context if it lacks enough information (tool-use loop)
- **Context compression**: LLM-based distillation of context before sending it (expensive but effective on contexts > 50K tokens)
- **Learned retrieval**: fine-tuning the embedding model on the specific codebase (very expensive, possible with small open-weight models like nomic-embed-text)

For now, the pragmatic strategy remains: **conservative token budget + terse format for small models + knowledge store for stable facts**.

---

## Testing approach

There are currently no automated tests. Recommended test strategy:

```
tests/
  fixtures/
    sample-repo/        small synthetic TS project for deterministic testing
      src/
        types.ts
        utils.ts        imports from types.ts
        service.ts      imports from both
  unit/
    hasher.test.ts
    chunker.test.ts
    parser.test.ts
    deps.test.ts        test import extraction and resolution
    vector.test.ts      test cosine similarity, edge cases
  integration/
    index.test.ts       run full index on sample-repo, assert output shape
    query.test.ts       run query on indexed sample-repo
```

Test runner: `vitest` (already in the parent project). Add to `package.json`:
```json
"devDependencies": { "vitest": "^2.0.0" },
"scripts": { "test": "vitest run" }
```

---

## File structure summary

```
vemora/
├── package.json
├── tsconfig.json
├── README.md
├── docs/
│   ├── architecture.md      system design and data flows
│   ├── codebase.md          file-by-file reference (LLM context doc)
│   ├── features-planned.md  deferred features with implementation sketches
│   └── development.md       this file
└── src/
    ├── cli.ts              entry point, commander setup
    ├── core/
    │   ├── types.ts        all TypeScript interfaces
    │   └── config.ts       constants, load/save config, defaults
    ├── storage/
    │   ├── repository.ts   R/W .vemora/ JSON files
    │   ├── cache.ts        R/W ~/.vemora-cache/ embeddings
    │   ├── summaries.ts    R/W .vemora/summaries/ (file + project summaries)
    │   ├── knowledge.ts    R/W .vemora/knowledge/entries.json (+ filterValidAt, invalidate)
    │   ├── session.ts      per-session seen-chunk tracking (~/.vemora-cache/<id>/session.json)
    │   └── usage.ts        append-only usage log (~/.vemora-cache/<id>/usage.log.json)
    ├── indexer/
    │   ├── scanner.ts      fast-glob repository scan
    │   ├── hasher.ts       SHA-256 file and content hashing
    │   ├── parser.ts       tree-sitter + regex symbol extraction
    │   ├── chunker.ts      symbol-boundary and sliding-window chunking
    │   └── deps.ts         import extraction and dependency graph
    ├── embeddings/
    │   ├── provider.ts     EmbeddingProvider interface
    │   ├── openai.ts       OpenAI text-embedding-3-*
    │   ├── ollama.ts       Ollama local models
    │   ├── noop.ts         no-op (keyword-only mode)
    │   └── factory.ts      createEmbeddingProvider(config)
    ├── search/
    │   ├── vector.ts       cosine similarity + TF keyword search
    │   ├── signature.ts    signature extraction + display tier logic
    │   ├── rerank.ts       cross-encoder reranking [NEW]
    │   └── formatter.ts    JSON / Markdown output formatters
    ├── utils/
    │   └── tokenizer.ts    heuristic token counting [NEW]
    └── commands/
        ├── init.ts         vemora init
        ├── init-claude.ts  vemora init-claude (thin wrapper → init-agent)
        ├── init-agent.ts   vemora init-agent (multi-agent instruction file generator)
        ├── index.ts        vemora index (orchestrates everything)
        ├── query.ts        vemora query (+ --format, --budget, symbol routing)
        ├── context.ts      vemora context (+ --budget, --structured, knowledge integration)
        ├── deps.ts         vemora deps <file>
        ├── usages.ts       vemora usages <symbol>
        ├── status.ts       vemora status (+ knowledge staleness detection)
        ├── overview.ts     vemora overview
        ├── chat.ts         vemora chat
        ├── bench.ts        vemora bench
        ├── summarize.ts    vemora summarize
        ├── remember.ts     vemora remember <text> (knowledge store write, LLM auto-classify)
        ├── brief.ts        vemora brief (session primer: overview + critical knowledge)
        ├── knowledge.ts    vemora knowledge list (--as-of, --expired) / forget (--invalidate)
        └── report.ts       vemora report (usage stats, token savings, latency, hot files, low-signal queries)
```

import chalk from "chalk";
import fs from "fs";
import ora from "ora";
import path from "path";
import { loadConfig } from "../core/config";
import { type SkillName, applySkill, getSkill } from "../skills";
import type {
  CallGraph,
  Chunk,
  DependencyGraph,
  FileSummaryIndex,
  KnowledgeEntry,
  SearchResult,
} from "../core/types";
import { getChangedFiles, getFileGitHistory } from "../utils/git";
import { createEmbeddingProvider } from "../embeddings/factory";
import { computeImportedBy } from "../indexer/deps";
import { findTestFiles } from "../indexer/tests";
import { computeBM25Scores } from "../search/bm25";
import { hybridSearch } from "../search/hybrid";
import { deduplicateBySimilarity, mergeAdjacentChunks } from "../search/merge";
import { applyMMR } from "../search/mmr";
import { rerankResults } from "../search/rerank";
import { formatTerse } from "../search/formatter";
import { extractSignature, HIGH_CODE_LINES } from "../search/signature";
import { keywordSearch, symbolLookup, vectorSearch } from "../search/vector";
import { EmbeddingCacheStorage } from "../storage/cache";
import { KnowledgeStorage, filterValidAt } from "../storage/knowledge";
import { RepositoryStorage } from "../storage/repository";
import { SessionStorage } from "../storage/session";
import type { UsageEvent } from "../storage/usage";
import { UsageStorage } from "../storage/usage";
import { SummaryStorage } from "../storage/summaries";
import { applyTokenBudget, sumResultTokens } from "../utils/tokenizer";

export interface ContextOptions {
  /** A natural-language query describing the task */
  query?: string;
  /** A specific file to include in full context */
  file?: string;
  /** Number of search results to pull in (default: 5) */
  topK?: number;
  /** Force keyword search */
  keyword?: boolean;
  /** Output format: markdown (default), plain, or terse (ultra-compact for small models) */
  format?: "markdown" | "plain" | "terse";
  /** Show full code (no line cap) */
  showCode?: boolean;
  /** Use cross-encoder reranking */
  rerank?: boolean;
  /** Use hybrid search (vector + BM25) */
  hybrid?: boolean;
  /** Hybrid weight for vector search (0-1) */
  alpha?: number;
  /**
   * Maximum tokens to include across all retrieved chunks.
   * Applied after retrieval and reranking. The first result is always kept.
   */
  budget?: number;
  /** Apply Maximal Marginal Relevance reranking to reduce redundant results */
  mmr?: boolean;
  /** MMR diversity weight: 0=max diversity, 1=pure relevance (default: 0.5) */
  lambda?: number;
  /** Merge adjacent or overlapping chunks from the same file */
  merge?: boolean;
  /** Max line gap between chunks to still merge them (default: 3) */
  mergeGap?: number;
  /**
   * Emit a structured context block organised by semantic role:
   * Entry Point → Direct Dependencies → Called By → Types & Interfaces → Related Patterns.
   * Reduces token usage and improves LLM comprehension compared to a flat ranked list.
   */
  structured?: boolean;
  /** Filter out chunks already seen in the current session */
  session?: boolean;
  /** Reset the session before this query (implies session tracking) */
  fresh?: boolean;
  /** Restrict search to files changed since this git ref (e.g. HEAD~5, main) */
  since?: string;
  /**
   * Task-type skill preset: pre-configures retrieval options and prepends a
   * focused instruction block to the output.
   *
   * Available: debug | refactor | add-feature | security | explain | test
   *
   * Explicit flags always override skill defaults.
   */
  skill?: SkillName;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runContext(
  rootDir: string,
  options: ContextOptions = {},
): Promise<void> {
  const config = loadConfig(rootDir);
  const repo = new RepositoryStorage(rootDir);
  const cacheStorage = new EmbeddingCacheStorage(config.projectId);
  const summaryStorage = new SummaryStorage(rootDir);

  // Apply skill defaults first; explicit user options override them.
  const skill = options.skill ? getSkill(options.skill) : undefined;
  if (skill) {
    options = applySkill(skill, options);
  }

  const topK = options.topK ?? 5;
  // Apply config.display.format as default if no explicit format was passed.
  const resolvedOptions: ContextOptions = {
    ...options,
    format: options.format ?? (config.display?.format as ContextOptions["format"]) ?? "markdown",
  };

  let chunks = repo.loadChunks();
  const symbols = repo.loadSymbols();
  const depGraph: DependencyGraph = repo.loadDeps();
  const callGraph: CallGraph = repo.loadCallGraph();
  const fileSummaries: FileSummaryIndex = summaryStorage.hasFileSummaries()
    ? summaryStorage.loadFileSummaries()
    : {};
  const projectSummary = summaryStorage.loadProjectSummary();
  const knowledgeEntries = filterValidAt(new KnowledgeStorage(rootDir).load());

  if (options.since) {
    const changedFiles = new Set(getChangedFiles(options.since, rootDir));
    if (changedFiles.size === 0) {
      console.log(chalk.yellow(`No changed files since ${options.since}.`));
      return;
    }
    chunks = chunks.filter((c) => changedFiles.has(c.file));
    if (chunks.length === 0) {
      console.log(chalk.yellow(`No indexed chunks in the diff since ${options.since}.`));
      return;
    }
    console.log(chalk.gray(`  Scope: ${changedFiles.size} changed file(s) since ${options.since}\n`));
  }

  if (chunks.length === 0) {
    console.error(chalk.red("No index found. Run `vemora index` first."));
    process.exit(1);
  }

  if (!options.query && !options.file) {
    console.error(chalk.red("Provide --query <text> and/or --file <path>."));
    process.exit(1);
  }

  let results: SearchResult[] = [];
  let searchType: UsageEvent["searchType"] = "none";
  let tokensSavedSession = 0;
  let tokensSavedDedup = 0;
  let tokensSavedBudget = 0;
  const usageStart = Date.now();

  if (typeof options.query === "string" && options.query.length > 0) {
    const useKeyword = options.keyword || config.embedding.provider === "none";
    const useHybrid = options.hybrid;

    // Symbol-aware routing: direct lookup for precise identifier queries.
    const symbolHits =
      !useHybrid && !useKeyword
        ? symbolLookup(options.query, chunks, symbols)
        : [];

    if (symbolHits.length > 0) {
      results = symbolHits;
      searchType = "symbol";
    } else if (useKeyword) {
      const spinner = ora("Performing hybrid search...").start();
      try {
        const cache = cacheStorage.load();
        if (
          !cache ||
          (cache.chunkIds?.length === 0 &&
            Object.keys(cache.embeddings ?? {}).length === 0)
        ) {
          spinner.warn("No embeddings — falling back to BM25.");
          results = computeBM25Scores(options.query, chunks, symbols, topK);
          searchType = "bm25";
        } else {
          const provider = createEmbeddingProvider(config.embedding);
          const [queryEmbedding] = await provider.embed([options.query]);
          spinner.succeed("Embedded");
          results = await hybridSearch(
            options.query,
            queryEmbedding,
            chunks,
            cache,
            symbols,
            {
              alpha: options.alpha,
              topK,
            },
          );
          searchType = "hybrid";
        }
      } catch (err) {
        spinner.fail(`Hybrid search failed: ${(err as Error).message}`);
        results = computeBM25Scores(options.query, chunks, symbols, topK);
        searchType = "bm25";
      }
    } else {
      const spinner = ora("Generating query embedding...").start();
      try {
        const cache = cacheStorage.load();
        const cachedCount = cache
          ? cache.chunkIds
            ? cache.chunkIds.length
            : Object.keys(cache.embeddings ?? {}).length
          : 0;
        if (!cache || cachedCount === 0) {
          spinner.warn("No embeddings — falling back to BM25.");
          results = computeBM25Scores(options.query, chunks, symbols, topK);
          searchType = "bm25";
        } else {
          const provider = createEmbeddingProvider(config.embedding);
          const [queryEmbedding] = await provider.embed([options.query]);
          spinner.succeed("Embedded");
          results = vectorSearch(queryEmbedding, chunks, cache, symbols, topK);
          searchType = "vector";
          if (results.length === 0) {
            results = computeBM25Scores(options.query, chunks, symbols, topK);
            searchType = "bm25";
          }
        }
      } catch (err) {
        spinner.fail(`Embedding failed: ${(err as Error).message}`);
        results = computeBM25Scores(options.query, chunks, symbols, topK);
        searchType = "bm25";
      }
    }

    // ── Reranking (optional) ──────────────────────────────────────────────
    if (options.rerank && results.length > 0) {
      results = await rerankResults(options.query, results, topK, config.reranker, config.summarization?.model);
    }

    // ── MMR deduplication (optional) ─────────────────────────────────────
    if (options.mmr && results.length > 1) {
      const cache = cacheStorage.load();
      results = applyMMR(results, cache, topK, options.lambda ?? 0.5);
    }

    // ── Adjacent chunk merge (optional) ──────────────────────────────────
    if (options.merge && results.length > 1) {
      results = mergeAdjacentChunks(results, options.mergeGap);
    }

    // ── Session filter (optional) ─────────────────────────────────────────
    const sessionStorage = new SessionStorage(config.projectId);
    if (options.fresh) sessionStorage.reset();
    if ((options.session || options.fresh) && results.length > 0) {
      const seenIds = sessionStorage.getSeenIds();
      if (seenIds.size > 0) {
        const tBefore = sumResultTokens(results);
        const unseen = results.filter((r) => !seenIds.has(r.chunk.id));
        results = unseen.length > 0 ? unseen : results.slice(0, 1);
        tokensSavedSession = tBefore - sumResultTokens(results);
      }
    }

    // ── Semantic deduplication (always-on) ───────────────────────────────
    if (results.length > 1) {
      const tBefore = sumResultTokens(results);
      const cache = cacheStorage.load();
      results = deduplicateBySimilarity(results, cache);
      tokensSavedDedup = tBefore - sumResultTokens(results);
    }

    // ── Token budget (optional) ───────────────────────────────────────────
    if (options.budget && options.budget > 0) {
      const tBefore = sumResultTokens(results);
      results = applyTokenBudget(results, options.budget);
      tokensSavedBudget = tBefore - sumResultTokens(results);
    }

    // ── Persist session ───────────────────────────────────────────────────
    if ((options.session || options.fresh) && results.length > 0) {
      sessionStorage.markSeen(results.map((r) => r.chunk.id));
    }

    // ── Record usage event ──────────────────────────────────────────────
    try {
      new UsageStorage(config.projectId).append({
        ts: new Date().toISOString(),
        command: "context",
        query: options.query?.slice(0, 120),
        searchType,
        format: options.format,
        topK,
        resultsReturned: results.length,
        tokensReturned: sumResultTokens(results),
        tokensSavedDedup,
        tokensSavedSession,
        tokensSavedBudget,
        durationMs: Date.now() - usageStart,
        topFiles: [...new Set(results.map((r) => r.chunk.file))].slice(0, 3),
      });
    } catch {
      // usage tracking is best-effort — never block the main output
    }
  }

  let contextStr = generateContextString(
    config,
    results,
    depGraph,
    callGraph,
    fileSummaries,
    projectSummary ? projectSummary.overview : null,
    resolvedOptions,
    rootDir,
    chunks,
    knowledgeEntries,
  );

  if (skill && resolvedOptions.format !== "terse") {
    contextStr = `${skill.outputPrefix}\n\n${contextStr}`;
  }

  console.log(contextStr);
}

/**
 * Procedural function to build the actual context string.
 * This is separated from runContext to allow for benchmarking and testing.
 *
 * When `options.structured` is true and results are available, delegates to
 * `generateStructuredContextString` which organises output by semantic role
 * (Entry Point → Direct Dependencies → Called By → Types & Interfaces → Related Patterns)
 * instead of a flat ranked list.
 *
 * @param allChunks - Full chunk corpus, required for structured mode dep resolution.
 *                    Optional for backward compatibility with bench.ts.
 */
export function generateContextString(
  config: { projectName: string },
  results: SearchResult[],
  depGraph: DependencyGraph,
  callGraph: CallGraph,
  fileSummaries: FileSummaryIndex,
  projectOverview: string | null,
  options: ContextOptions,
  rootDir: string,
  allChunks: Chunk[] = [],
  knowledgeEntries: KnowledgeEntry[] = [],
): string {
  if (options.structured && results.length > 0) {
    return generateStructuredContextString(
      config,
      results,
      depGraph,
      callGraph,
      fileSummaries,
      projectOverview,
      options,
      rootDir,
      allChunks,
      knowledgeEntries,
    );
  }

  if (options.format === "terse") {
    const lines: string[] = [];
    lines.push(`# ${config.projectName}`);
    lines.push("");
    const relevant = rankKnowledgeEntries(options.query, results, knowledgeEntries);
    for (const entry of relevant) {
      lines.push(`[${entry.category}] ${entry.title}: ${entry.body}`);
    }
    if (relevant.length > 0) lines.push("");
    lines.push(formatTerse(results, {}));
    return lines.join("\n");
  }

  const fmt = options.format ?? "markdown";
  const lines: string[] = [];
  const hr = fmt === "markdown" ? "---" : "=".repeat(60);
  const importedByMap = computeImportedBy(depGraph);

  // ── Section: Project overview ──────────────────────────────────────────────
  lines.push(
    fmt === "markdown"
      ? `# AI Context — ${config.projectName}`
      : `=== AI CONTEXT BLOCK — ${config.projectName.toUpperCase()} ===`,
  );
  lines.push("");

  if (projectOverview) {
    lines.push(
      fmt === "markdown" ? "## Project Overview" : "[Project Overview]",
    );
    lines.push("");
    lines.push(projectOverview);
    lines.push("");
    lines.push(hr);
    lines.push("");
  }

  // ── Section: Knowledge entries ────────────────────────────────────────────
  const relevantKnowledge = rankKnowledgeEntries(
    options.query,
    results,
    knowledgeEntries,
  );
  if (relevantKnowledge.length > 0) {
    lines.push(fmt === "markdown" ? "## Knowledge" : "[Knowledge]");
    lines.push("");
    for (const entry of relevantKnowledge) {
      const badge =
        fmt === "markdown" ? `\`${entry.category}\`` : entry.category;
      lines.push(
        fmt === "markdown"
          ? `**${entry.title}** ${badge}`
          : `${entry.title} [${entry.category}]`,
      );
      lines.push(entry.body);
      if (entry.relatedFiles?.length) {
        lines.push(
          fmt === "markdown"
            ? `_Files: ${entry.relatedFiles.map((f) => `\`${f}\``).join(", ")}_`
            : `Files: ${entry.relatedFiles.join(", ")}`,
        );
      }
      lines.push("");
    }
    lines.push(hr);
    lines.push("");
  }

  // ── Section: Specific file context ────────────────────────────────────────
  if (options.file) {
    const relFile = resolveRelPath(rootDir, options.file);
    lines.push(fmt === "markdown" ? "## File Context" : "[File Context]");
    lines.push("");
    lines.push(
      fmt === "markdown" ? `**File:** \`${relFile}\`` : `File: ${relFile}`,
    );
    lines.push("");

    // Full file content
    const absPath = path.join(rootDir, relFile);
    if (fs.existsSync(absPath)) {
      // Resolve symlinks before reading to prevent traversal via symlinks
      const realRoot = fs.realpathSync(path.resolve(rootDir));
      const realPath = fs.realpathSync(absPath);
      if (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
        throw new Error(`File path escapes project root via symlink: ${options.file}`);
      }
      const content = fs.readFileSync(realPath, "utf-8");
      const ext = relFile.split(".").pop() ?? "";
      if (fmt === "markdown") {
        lines.push(`\`\`\`${ext}`);
        lines.push(content);
        lines.push("```");
      } else {
        lines.push(content);
      }
      lines.push("");
    } else {
      lines.push(fmt === "markdown" ? "_File not found._" : "(file not found)");
      lines.push("");
    }

    // Imports and used-by for the file
    const fileDeps = depGraph[relFile];
    const usedBy = importedByMap.get(relFile) ?? [];

    if (fileDeps?.imports.length) {
      lines.push(
        fmt === "markdown"
          ? "**Imports from project:**"
          : "Imports from project:",
      );
      for (const imp of fileDeps.imports) {
        const syms =
          imp.symbols.length > 0 ? ` (${imp.symbols.join(", ")})` : "";
        lines.push(
          fmt === "markdown"
            ? `- \`${imp.file}\`${syms}`
            : `  - ${imp.file}${syms}`,
        );
      }
      lines.push("");
    }

    if (usedBy.length > 0) {
      lines.push(fmt === "markdown" ? "**Used by:**" : "Used by:");
      for (const caller of usedBy) {
        lines.push(fmt === "markdown" ? `- \`${caller}\`` : `  - ${caller}`);
      }
      lines.push("");
    }

    // Git commit history for this file
    const commits = getFileGitHistory(rootDir, relFile);
    if (commits.length > 0) {
      lines.push(fmt === "markdown" ? "**Recent commits:**" : "Recent commits:");
      for (const c of commits) {
        lines.push(
          fmt === "markdown"
            ? `- \`${c.sha}\` ${c.message} _(${c.author}, ${c.date})_`
            : `  - ${c.sha} ${c.message} (${c.author}, ${c.date})`,
        );
      }
      lines.push("");
    }

    // TODOs / FIXMEs in this file
    const fileTodos = new RepositoryStorage(rootDir).loadTodos().filter(
      (t) => t.file === relFile,
    );
    if (fileTodos.length > 0) {
      lines.push(fmt === "markdown" ? "**TODOs / FIXMEs:**" : "TODOs / FIXMEs:");
      for (const t of fileTodos) {
        lines.push(
          fmt === "markdown"
            ? `- **${t.type}** (line ${t.line}): ${t.text}`
            : `  - ${t.type} (line ${t.line}): ${t.text}`,
        );
      }
      lines.push("");
    }

    // Test files linked to this source file
    const allFileKeys = [...new Set(allChunks.map((c) => c.file))];
    const testFiles = findTestFiles(relFile, allFileKeys, importedByMap);
    if (testFiles.length > 0) {
      lines.push(fmt === "markdown" ? "**Test files:**" : "Test files:");
      for (const tf of testFiles) {
        lines.push(fmt === "markdown" ? `- \`${tf}\`` : `  - ${tf}`);
      }
      lines.push("");
    }

    // Caller context: symbols exported by this file and who calls them
    const fileSymbols = [
      ...new Set(
        allChunks
          .filter((c) => c.file === relFile && c.symbol)
          .map((c) => c.symbol as string),
      ),
    ];
    const callerRows: string[] = [];
    for (const sym of fileSymbols) {
      const callInfo = callGraph[`${relFile}:${sym}`];
      if (callInfo?.calledBy.length) {
        const callers = callInfo.calledBy.slice(0, 5);
        const rest = callInfo.calledBy.length - callers.length;
        const callerList =
          fmt === "markdown"
            ? callers.map((c) => `\`${c}\``).join(", ") +
              (rest > 0 ? ` _+${rest} more_` : "")
            : callers.join(", ") + (rest > 0 ? ` +${rest} more` : "");
        callerRows.push(
          fmt === "markdown"
            ? `- \`${sym}\` ← ${callerList}`
            : `  - ${sym} <- ${callerList}`,
        );
      }
    }
    if (callerRows.length > 0) {
      lines.push(fmt === "markdown" ? "**Symbol callers:**" : "Symbol callers:");
      lines.push(...callerRows);
      lines.push("");
    }

    lines.push(hr);
    lines.push("");
  }

  // ── Section: Relevant code via query ──────────────────────────────────────
  if (options.query) {
    lines.push(fmt === "markdown" ? "## Relevant Code" : "[Relevant Code]");
    lines.push("");

    if (results.length === 0) {
      lines.push("_No relevant results found._");
    } else {
      const seen = new Set<string>();

      for (const { chunk, score, symbol } of results) {
        if (seen.has(chunk.id)) continue;
        seen.add(chunk.id);

        const ext = chunk.file.split(".").pop() ?? "";
        const symLabel = chunk.symbol
          ? ` — ${symbol?.type ?? "symbol"} \`${chunk.symbol}\``
          : "";

        if (fmt === "markdown") {
          lines.push(`### \`${chunk.file}\`${symLabel}`);
          lines.push(
            `Lines ${chunk.start}–${chunk.end} · Score: ${score.toFixed(4)}`,
          );
        } else {
          lines.push(`[${chunk.file}${symLabel}]`);
          lines.push(
            `lines ${chunk.start}–${chunk.end}  score: ${score.toFixed(4)}`,
          );
        }
        lines.push("");

        // Deps context (only if graph available)
        const fileDeps = depGraph[chunk.file];
        const usedBy = importedByMap.get(chunk.file) ?? [];

        if (fileDeps?.imports.length) {
          lines.push(fmt === "markdown" ? "**Imports:**" : "Imports:");
          for (const imp of fileDeps.imports.slice(0, 5)) {
            const syms =
              imp.symbols.length > 0
                ? ` (${imp.symbols.slice(0, 4).join(", ")})`
                : "";
            lines.push(
              fmt === "markdown"
                ? `- \`${imp.file}\`${syms}`
                : `  - ${imp.file}${syms}`,
            );
          }
          lines.push("");
        }

        if (usedBy.length > 0) {
          lines.push(fmt === "markdown" ? "**Used by:**" : "Used by:");
          for (const caller of usedBy.slice(0, 3)) {
            lines.push(
              fmt === "markdown" ? `- \`${caller}\`` : `  - ${caller}`,
            );
          }
          lines.push("");
        }

        // Call Graph context
        const symbolId = chunk.symbol ? `${chunk.file}:${chunk.symbol}` : null;
        const callInfo = symbolId ? callGraph[symbolId] : null;

        if (callInfo) {
          if (callInfo.calls.length > 0) {
            lines.push(fmt === "markdown" ? "**Calls:**" : "Calls:");
            for (const call of callInfo.calls.slice(0, 5)) {
              const loc = call.file ? ` (in \`${call.file}\`)` : "";
              lines.push(
                fmt === "markdown"
                  ? `- \`${call.name}\`${loc}`
                  : `  - ${call.name}${loc}`,
              );
            }
            lines.push("");
          }

          if (callInfo.calledBy.length > 0) {
            lines.push(fmt === "markdown" ? "**Called by:**" : "Called by:");
            for (const callerId of callInfo.calledBy.slice(0, 5)) {
              lines.push(
                fmt === "markdown" ? `- \`${callerId}\`` : `  - ${callerId}`,
              );
            }
            lines.push("");
          }
        }

        // Code
        const codeLines = chunk.content.split("\n");
        const limit = options.showCode ? codeLines.length : HIGH_CODE_LINES;
        const preview = codeLines.slice(0, limit).join("\n");
        const truncated = codeLines.length > limit;

        if (fmt === "markdown") {
          lines.push(`\`\`\`${ext}`);
          lines.push(preview);
          if (truncated)
            lines.push(`// … (${codeLines.length - limit} more lines)`);
          lines.push("```");
        } else {
          lines.push(preview);
          if (truncated)
            lines.push(`... (${codeLines.length - limit} more lines)`);
        }

        lines.push("");
        lines.push(hr);
        lines.push("");
      }
    }
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  lines.push(
    fmt === "markdown"
      ? `_Generated by \`vemora context\` — ${new Date().toISOString()}_`
      : `=== END AI CONTEXT BLOCK — ${new Date().toISOString()} ===`,
  );

  return lines.join("\n");
}

// ─── Knowledge ranking ────────────────────────────────────────────────────────

/**
 * Ranks knowledge entries by relevance to the current query and result set.
 *
 * Scoring (higher = more relevant):
 *  +10  relatedFiles overlaps with result files
 *  +8   relatedSymbols overlaps with result symbols
 *  +2   per query term found in title+body
 *  +4/3/2/1  category weight: gotcha > pattern > decision > glossary
 *  +1   confidence === 'high'
 *
 * Only entries with score > 0 are returned (max 5, sorted descending).
 */
function rankKnowledgeEntries(
  query: string | undefined,
  results: SearchResult[],
  entries: KnowledgeEntry[],
  maxEntries = 5,
): KnowledgeEntry[] {
  if (entries.length === 0) return [];

  const resultFiles = new Set(results.map((r) => r.chunk.file));
  const resultSymbols = new Set(
    results.flatMap((r) => (r.chunk.symbol ? [r.chunk.symbol] : [])),
  );
  const categoryWeight: Record<string, number> = {
    gotcha: 4,
    pattern: 3,
    decision: 2,
    glossary: 1,
  };
  const queryTerms = query
    ? new Set(
        query
          .toLowerCase()
          .split(/[\s\W]+/)
          .filter((t) => t.length >= 2),
      )
    : new Set<string>();

  const scored = entries.map((entry) => {
    let score = 0;
    if (entry.relatedFiles?.some((f) => resultFiles.has(f))) score += 10;
    if (entry.relatedSymbols?.some((s) => resultSymbols.has(s))) score += 8;
    if (queryTerms.size > 0) {
      const text = `${entry.title} ${entry.body}`.toLowerCase();
      for (const term of queryTerms) {
        if (text.includes(term)) score += 2;
      }
    }
    score += categoryWeight[entry.category] ?? 1;
    if (entry.confidence === "high") score += 1;
    return { entry, score };
  });

  return scored
    .filter((s) => s.score > (categoryWeight[s.entry.category] ?? 1)) // exclude pure category-weight matches
    .sort((a, b) => b.score - a.score)
    .slice(0, maxEntries)
    .map((s) => s.entry);
}

// ─── Structured context renderer ─────────────────────────────────────────────

/**
 * Renders a structured context block organised by semantic role:
 *
 *   ## Entry Point         — top-ranked chunk, full code
 *   ## Direct Dependencies — signatures of functions called by the entry point (call graph depth-1)
 *   ## Called By           — callers of the entry point (contract context)
 *   ## Types & Interfaces  — interface/type chunks from the result set
 *   ## Related Patterns    — remaining result chunks (signatures to save tokens)
 *
 * This layout reduces token usage by ~20-35% compared to the flat list and
 * helps LLMs navigate the codebase more effectively because the relationships
 * are explicit rather than implied by rank.
 */
function generateStructuredContextString(
  config: { projectName: string },
  results: SearchResult[],
  depGraph: DependencyGraph,
  callGraph: CallGraph,
  fileSummaries: FileSummaryIndex,
  projectOverview: string | null,
  options: ContextOptions,
  _rootDir: string,
  allChunks: Chunk[],
  knowledgeEntries: KnowledgeEntry[] = [],
): string {
  const fmt = options.format ?? "markdown";
  const hr = fmt === "markdown" ? "---" : "=".repeat(60);
  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push(
    fmt === "markdown"
      ? `# AI Context — ${config.projectName}`
      : `=== AI CONTEXT BLOCK — ${config.projectName.toUpperCase()} ===`,
  );
  if (options.query) {
    lines.push("");
    lines.push(
      fmt === "markdown"
        ? `> **Query:** ${options.query}`
        : `Query: ${options.query}`,
    );
  }
  lines.push("");

  if (projectOverview) {
    lines.push(
      fmt === "markdown" ? "## Project Overview" : "[Project Overview]",
    );
    lines.push("");
    lines.push(projectOverview);
    lines.push("");
    lines.push(hr);
    lines.push("");
  }

  // ── Section: Knowledge entries ────────────────────────────────────────────
  const relevantKnowledge = rankKnowledgeEntries(
    options.query,
    results,
    knowledgeEntries,
  );
  if (relevantKnowledge.length > 0) {
    lines.push(fmt === "markdown" ? "## Knowledge" : "[Knowledge]");
    lines.push("");
    for (const entry of relevantKnowledge) {
      const badge =
        fmt === "markdown" ? `\`${entry.category}\`` : entry.category;
      lines.push(
        fmt === "markdown"
          ? `**${entry.title}** ${badge}`
          : `${entry.title} [${entry.category}]`,
      );
      lines.push(entry.body);
      if (entry.relatedFiles?.length) {
        lines.push(
          fmt === "markdown"
            ? `_Files: ${entry.relatedFiles.map((f) => `\`${f}\``).join(", ")}_`
            : `Files: ${entry.relatedFiles.join(", ")}`,
        );
      }
      lines.push("");
    }
    lines.push(hr);
    lines.push("");
  }

  // ── Partition results ─────────────────────────────────────────────────────
  const seen = new Set<string>();
  const dedupedResults = results.filter((r) => {
    if (seen.has(r.chunk.id)) return false;
    seen.add(r.chunk.id);
    return true;
  });

  const topResult = dedupedResults[0];
  const typeResults = dedupedResults
    .slice(1)
    .filter((r) => r.symbol?.type === "interface" || r.symbol?.type === "type");
  const relatedResults = dedupedResults
    .slice(1)
    .filter((r) => r.symbol?.type !== "interface" && r.symbol?.type !== "type");

  // ── Section 1: Entry Point ────────────────────────────────────────────────
  lines.push(fmt === "markdown" ? "## Entry Point" : "[Entry Point]");
  lines.push("");

  {
    const { chunk, score, symbol } = topResult;
    const ext = chunk.file.split(".").pop() ?? "";
    const symLabel = chunk.symbol
      ? ` — ${symbol?.type ?? "symbol"} \`${chunk.symbol}\``
      : "";

    lines.push(
      fmt === "markdown"
        ? `**\`${chunk.file}\`**${symLabel}`
        : `${chunk.file}${symLabel}`,
    );
    lines.push(
      `Lines ${chunk.start}–${chunk.end} · Score: ${score.toFixed(4)}`,
    );
    lines.push("");

    const codeLines = chunk.content.split("\n");
    const limit = options.showCode ? codeLines.length : HIGH_CODE_LINES;
    const preview = codeLines.slice(0, limit).join("\n");
    lines.push(fmt === "markdown" ? `\`\`\`${ext}` : "");
    lines.push(preview);
    if (codeLines.length > limit) {
      lines.push(
        `// … (${codeLines.length - limit} more lines — use --show-code to expand)`,
      );
    }
    if (fmt === "markdown") lines.push("```");
    lines.push("");
  }

  lines.push(hr);
  lines.push("");

  // ── Section 2: Direct Dependencies (call graph depth-1) ───────────────────
  const topSymbolId = topResult.chunk.symbol
    ? `${topResult.chunk.file}:${topResult.chunk.symbol}`
    : null;
  const callInfo = topSymbolId ? callGraph[topSymbolId] : null;

  if (callInfo?.calls.length) {
    lines.push(
      fmt === "markdown" ? "## Direct Dependencies" : "[Direct Dependencies]",
    );
    lines.push("");

    let depCount = 0;
    for (const call of callInfo.calls.slice(0, 8)) {
      // Look up a matching chunk (prefer same file if provided)
      const matching =
        allChunks.find(
          (c) => c.symbol === call.name && (!call.file || c.file === call.file),
        ) ?? allChunks.find((c) => c.symbol === call.name);

      const chunkFile = matching?.file ?? call.file ?? "(external)";
      const ext = chunkFile.split(".").pop() ?? "";
      const sig = matching
        ? extractSignature(matching.content)
        : `// ${call.name} — not found in index`;

      lines.push(
        fmt === "markdown"
          ? `**\`${chunkFile}\`** — \`${call.name}\``
          : `${chunkFile} — ${call.name}`,
      );
      lines.push("");
      lines.push(fmt === "markdown" ? `\`\`\`${ext}` : "");
      lines.push(sig);
      if (fmt === "markdown") lines.push("```");
      lines.push("");
      depCount++;
    }

    const hiddenDeps =
      callInfo.calls.length - Math.min(callInfo.calls.length, 8);
    if (hiddenDeps > 0) {
      lines.push(
        fmt === "markdown"
          ? `_…and ${hiddenDeps} more calls (see call graph)_`
          : `...and ${hiddenDeps} more calls`,
      );
      lines.push("");
    }

    if (depCount > 0) {
      lines.push(hr);
      lines.push("");
    }
  }

  // ── Section 3: Called By ──────────────────────────────────────────────────
  if (callInfo?.calledBy.length) {
    lines.push(fmt === "markdown" ? "## Called By" : "[Called By]");
    lines.push("");

    for (const callerId of callInfo.calledBy.slice(0, 6)) {
      lines.push(fmt === "markdown" ? `- \`${callerId}\`` : `  - ${callerId}`);
    }
    if (callInfo.calledBy.length > 6) {
      lines.push(
        fmt === "markdown"
          ? `- _…and ${callInfo.calledBy.length - 6} more_`
          : `  ...and ${callInfo.calledBy.length - 6} more`,
      );
    }
    lines.push("");
    lines.push(hr);
    lines.push("");
  }

  // ── Section 4: Types & Interfaces ────────────────────────────────────────
  if (typeResults.length > 0) {
    lines.push(
      fmt === "markdown" ? "## Types & Interfaces" : "[Types & Interfaces]",
    );
    lines.push("");

    for (const { chunk } of typeResults) {
      const ext = chunk.file.split(".").pop() ?? "";
      lines.push(
        fmt === "markdown"
          ? `**\`${chunk.file}\`** — \`${chunk.symbol}\``
          : `${chunk.file} — ${chunk.symbol}`,
      );
      lines.push("");
      lines.push(fmt === "markdown" ? `\`\`\`${ext}` : "");
      lines.push(extractSignature(chunk.content));
      if (fmt === "markdown") lines.push("```");
      lines.push("");
    }

    lines.push(hr);
    lines.push("");
  }

  // ── Section 5: Related Patterns ───────────────────────────────────────────
  if (relatedResults.length > 0) {
    lines.push(
      fmt === "markdown" ? "## Related Patterns" : "[Related Patterns]",
    );
    lines.push("");

    for (const { chunk, score, symbol } of relatedResults) {
      const ext = chunk.file.split(".").pop() ?? "";
      const symLabel = chunk.symbol
        ? ` — ${symbol?.type ?? "symbol"} \`${chunk.symbol}\``
        : "";

      lines.push(
        fmt === "markdown"
          ? `### \`${chunk.file}\`${symLabel}`
          : `${chunk.file}${symLabel}`,
      );
      lines.push(`Score: ${score.toFixed(4)}`);
      lines.push("");

      // Use signature to keep tokens low for secondary results
      const display = chunk.symbol
        ? extractSignature(chunk.content)
        : chunk.content.split("\n").slice(0, 10).join("\n") +
          (chunk.content.split("\n").length > 10 ? "\n// …" : "");

      lines.push(fmt === "markdown" ? `\`\`\`${ext}` : "");
      lines.push(display);
      if (fmt === "markdown") lines.push("```");
      lines.push("");
    }

    lines.push(hr);
    lines.push("");
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  lines.push(
    fmt === "markdown"
      ? `_Generated by \`vemora context --structured\` — ${new Date().toISOString()}_`
      : `=== END AI CONTEXT BLOCK — ${new Date().toISOString()} ===`,
  );

  return lines.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve a file argument to a project-relative path.
 *
 * Accepts:
 *   - Absolute paths                         → relativised against rootDir
 *   - Paths already relative to rootDir      → used as-is if the file exists
 *   - Paths relative to cwd                  → resolved to absolute, then relativised
 */
function resolveRelPath(rootDir: string, filePath: string): string {
  const resolvedRoot = path.resolve(rootDir);

  let absPath: string;
  if (path.isAbsolute(filePath)) {
    absPath = filePath;
  } else {
    // Try relative to rootDir first, then fall back to cwd
    const fromRoot = path.join(resolvedRoot, filePath);
    absPath = fs.existsSync(fromRoot)
      ? fromRoot
      : path.resolve(process.cwd(), filePath);
  }

  // Guard: reject paths that escape the project root (path traversal)
  const normalised = path.resolve(absPath);
  if (
    !normalised.startsWith(resolvedRoot + path.sep) &&
    normalised !== resolvedRoot
  ) {
    throw new Error(`File path escapes project root: ${filePath}`);
  }

  return path.relative(resolvedRoot, normalised);
}

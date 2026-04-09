import chalk from "chalk";
import ora from "ora";
import { loadConfig } from "../core/config";
import type {
  CallGraph,
  DependencyGraph,
  FileSummaryIndex,
  SearchResult,
} from "../core/types";
import { createEmbeddingProvider } from "../embeddings/factory";
import { computeImportedBy } from "../indexer/deps";
import { computeBM25Scores } from "../search/bm25";
import type { OutputFormat } from "../search/formatter";
import { formatJson, formatMarkdown, formatTerse } from "../search/formatter";
import { hybridSearch } from "../search/hybrid";
import { deduplicateBySimilarity, mergeAdjacentChunks } from "../search/merge";
import { applyMMR } from "../search/mmr";
import { rerankResults } from "../search/rerank";
import {
  extractSignature,
  getDisplayTier,
  HIGH_CODE_LINES,
} from "../search/signature";
import { keywordSearch, symbolLookup, vectorSearch } from "../search/vector";
import { EmbeddingCacheStorage } from "../storage/cache";
import { RepositoryStorage } from "../storage/repository";
import { SessionStorage } from "../storage/session";
import type { UsageEvent } from "../storage/usage";
import { UsageStorage } from "../storage/usage";
import { SummaryStorage } from "../storage/summaries";
import { applyTokenBudget, sumResultTokens } from "../utils/tokenizer";

export interface QueryOptions {
  topK?: number;
  /**
   * Show full code for ALL results (no line limit, overrides tier system).
   * Default behaviour already shows code automatically for the top 3 results.
   */
  showCode?: boolean;
  /** Force keyword search even if embeddings are available */
  keyword?: boolean;
  /** Output format: 'terminal' (default), 'json', 'markdown' */
  format?: OutputFormat;
  /** Use cross-encoder reranking */
  rerank?: boolean;
  /** Use hybrid search (vector + BM25) */
  hybrid?: boolean;
  /** Hybrid weight for vector search (0-1) */
  alpha?: number;
  /**
   * Maximum tokens to include in results. Applied after retrieval and reranking.
   * Overrides topK as an upper bound — results are accumulated until the budget
   * is reached. The first result is always included.
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
  /** Filter out chunks already seen in the current session */
  session?: boolean;
  /** Reset the session before this query (implies session tracking) */
  fresh?: boolean;
}

export async function runQuery(
  rootDir: string,
  question: string,
  options: QueryOptions = {},
): Promise<void> {
  const config = loadConfig(rootDir);
  const repo = new RepositoryStorage(rootDir);
  const cacheStorage = new EmbeddingCacheStorage(config.projectId);

  const topK = options.topK ?? 10;
  const fmt: OutputFormat =
    options.format ?? (config.display?.format as OutputFormat) ?? "terminal";

  const chunks = repo.loadChunks();
  const symbols = repo.loadSymbols();
  const depGraph: DependencyGraph = repo.loadDeps();
  const callGraph: CallGraph = repo.loadCallGraph();
  const importedByMap = computeImportedBy(depGraph);

  // Load file summaries if available
  const summaryStorage = new SummaryStorage(rootDir);
  const fileSummaries: FileSummaryIndex = summaryStorage.hasFileSummaries()
    ? summaryStorage.loadFileSummaries()
    : {};

  if (chunks.length === 0) {
    if (fmt === "json") {
      console.log(
        JSON.stringify({
          error: "No index found. Run `vemora index` first.",
        }),
      );
    } else {
      console.log(chalk.yellow("No index found. Run `vemora index` first."));
    }
    process.exit(1);
  }

  let results: SearchResult[];
  let searchType: UsageEvent["searchType"] = "bm25";
  const usageStart = Date.now();

  // ── Search execution ───────────────────────────────────────────────────────

  // Symbol-aware routing: if the query closely matches a known symbol name,
  // retrieve it directly without an embedding API call.
  // Disabled for --hybrid (combined scoring makes less sense) and --keyword.
  const useKeyword = options.keyword || config.embedding.provider === "none";
  const useHybrid = options.hybrid;

  const symbolHits =
    !useHybrid && !useKeyword ? symbolLookup(question, chunks, symbols) : [];

  if (symbolHits.length > 0) {
    searchType = "symbol";
    if (fmt === "terminal") {
      console.log(
        chalk.gray(
          `Symbol match — skipping embedding (${symbolHits.length} hit(s)).`,
        ),
      );
    }
    results = symbolHits;
  } else if (useKeyword) {
    const spinner =
      fmt === "terminal" ? ora("Performing hybrid search...").start() : null;
    try {
      const cache = cacheStorage.load();
      if (
        !cache ||
        (cache.chunkIds?.length === 0 &&
          Object.keys(cache.embeddings ?? {}).length === 0)
      ) {
        spinner?.warn("No embeddings cached — falling back to BM25.");
        results = computeBM25Scores(question, chunks, symbols, topK);
        searchType = "bm25";
      } else {
        const provider = createEmbeddingProvider(config.embedding);
        const [queryEmbedding] = await provider.embed([question]);
        spinner?.succeed("Query embedded");
        results = await hybridSearch(
          question,
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
      spinner?.fail(`Hybrid search failed: ${(err as Error).message}`);
      if (fmt === "terminal")
        console.log(chalk.gray("Falling back to BM25..."));
      results = computeBM25Scores(question, chunks, symbols, topK);
      searchType = "bm25";
    }
  } else {
    const spinner =
      fmt === "terminal" ? ora("Generating query embedding...").start() : null;
    try {
      const cache = cacheStorage.load();
      const cachedCount = cache
        ? cache.chunkIds
          ? cache.chunkIds.length
          : Object.keys(cache.embeddings ?? {}).length
        : 0;

      if (!cache || cachedCount === 0) {
        spinner?.warn("No embeddings cached — falling back to BM25.");
        results = computeBM25Scores(question, chunks, symbols, topK);
        searchType = "bm25";
      } else {
        const provider = createEmbeddingProvider(config.embedding);
        const [queryEmbedding] = await provider.embed([question]);
        spinner?.succeed("Query embedded");
        results = vectorSearch(queryEmbedding, chunks, cache, symbols, topK);
        searchType = "vector";

        if (results.length === 0) {
          if (fmt === "terminal")
            console.log(
              chalk.gray("No semantic results — falling back to BM25."),
            );
          results = computeBM25Scores(question, chunks, symbols, topK);
          searchType = "bm25";
        }
      }
    } catch (err) {
      spinner?.fail(`Embedding failed: ${(err as Error).message}`);
      if (fmt === "terminal")
        console.log(chalk.gray("Falling back to BM25..."));
      results = computeBM25Scores(question, chunks, symbols, topK);
      searchType = "bm25";
    }
  }

  // ── Reranking (optional) ───────────────────────────────────────────────────
  if (options.rerank && results.length > 0) {
    if (fmt === "terminal") {
      console.log(chalk.gray(`Reranking top ${results.length} results...`));
    }
    results = await rerankResults(question, results, topK, config.reranker, config.summarization?.model);
  }

  // ── MMR deduplication (optional) ───────────────────────────────────────────
  if (options.mmr && results.length > 1) {
    const cache = cacheStorage.load();
    const before = results.length;
    results = applyMMR(results, cache, topK, options.lambda ?? 0.5);
    if (fmt === "terminal" && results.length < before) {
      console.log(
        chalk.gray(
          `MMR (λ=${options.lambda ?? 0.5}): kept ${results.length}/${before} diverse results.`,
        ),
      );
    }
  }

  // ── Adjacent chunk merge (optional) ───────────────────────────────────────
  if (options.merge && results.length > 1) {
    const before = results.length;
    results = mergeAdjacentChunks(results, options.mergeGap);
    if (fmt === "terminal" && results.length < before) {
      console.log(
        chalk.gray(
          `Merge: ${before} chunks → ${results.length} after merging adjacent.`,
        ),
      );
    }
  }

  // ── Usage tracking — token snapshots ─────────────────────────────────────
  let tokensSavedSession = 0;
  let tokensSavedDedup = 0;
  let tokensSavedBudget = 0;

  // ── Session filter (optional) ─────────────────────────────────────────────
  const sessionStorage = new SessionStorage(config.projectId);
  if (options.fresh) sessionStorage.reset();
  if ((options.session || options.fresh) && results.length > 0) {
    const seenIds = sessionStorage.getSeenIds();
    if (seenIds.size > 0) {
      const tBefore = sumResultTokens(results);
      const before = results.length;
      const unseen = results.filter((r) => !seenIds.has(r.chunk.id));
      if (unseen.length === 0) {
        if (fmt === "terminal") {
          console.log(
            chalk.gray(
              "All results already seen in this session. Use --fresh to reset.",
            ),
          );
        }
        results = results.slice(0, 1); // always return at least one result
      } else {
        results = unseen;
        if (fmt === "terminal" && unseen.length < before) {
          console.log(
            chalk.gray(
              `Session: skipped ${before - unseen.length} already-seen chunk(s).`,
            ),
          );
        }
      }
      tokensSavedSession = tBefore - sumResultTokens(results);
    }
  }

  // ── Semantic deduplication (always-on) ────────────────────────────────────
  if (results.length > 1) {
    const tBefore = sumResultTokens(results);
    const before = results.length;
    const cache = cacheStorage.load();
    results = deduplicateBySimilarity(results, cache);
    if (fmt === "terminal" && results.length < before) {
      console.log(
        chalk.gray(
          `Dedup: removed ${before - results.length} near-duplicate chunk(s).`,
        ),
      );
    }
    tokensSavedDedup = tBefore - sumResultTokens(results);
  }

  // ── Token budget (optional) ────────────────────────────────────────────────
  if (options.budget && options.budget > 0) {
    const tBefore = sumResultTokens(results);
    const before = results.length;
    results = applyTokenBudget(results, options.budget);
    if (fmt === "terminal" && results.length < before) {
      console.log(
        chalk.gray(
          `Budget ${options.budget} tokens: kept ${results.length}/${before} results.`,
        ),
      );
    }
    tokensSavedBudget = tBefore - sumResultTokens(results);
  }

  // ── Persist session ───────────────────────────────────────────────────────
  if ((options.session || options.fresh) && results.length > 0) {
    sessionStorage.markSeen(results.map((r) => r.chunk.id));
  }

  // ── Record usage event ────────────────────────────────────────────────────
  try {
    new UsageStorage(config.projectId).append({
      ts: new Date().toISOString(),
      command: "query",
      query: question.slice(0, 120),
      searchType,
      format: fmt,
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

  // ── Output ─────────────────────────────────────────────────────────────────
  if (results.length === 0) {
    if (fmt === "json") {
      console.log(
        JSON.stringify({ query: question, totalResults: 0, results: [] }),
      );
    } else if (fmt === "markdown") {
      console.log(
        `## Relevant code for: \`${question}\`\n\n_No results found._`,
      );
    } else {
      console.log(chalk.yellow("No results found for: ") + question);
    }
    return;
  }

  if (fmt === "json") {
    console.log(
      formatJson(question, results, depGraph, fileSummaries, {
        format: "json",
        showCode: options.showCode,
        topK,
      }),
    );
    return;
  }

  if (fmt === "markdown") {
    console.log(
      formatMarkdown(question, results, depGraph, fileSummaries, callGraph, {
        format: "markdown",
        showCode: options.showCode,
        topK,
      }),
    );
    return;
  }

  if (fmt === "terse") {
    console.log(formatTerse(results, { topK }));
    return;
  }

  // ── Terminal output (original) ─────────────────────────────────────────────
  console.log();
  console.log(chalk.bold("Relevant code:"));
  console.log();

  // Deduplicate at chunk level
  const seenChunks = new Set<string>();
  let displayed = 0;

  for (const { chunk, score, symbol } of results) {
    if (seenChunks.has(chunk.id)) continue;
    seenChunks.add(chunk.id);

    // rank is 1-based position in displayed results
    const rank = displayed + 1;
    const tier = options.showCode ? "high" : getDisplayTier(rank);

    // ── File path + symbol header ────────────────────────────────────────────
    console.log(chalk.cyan(chunk.file));
    if (chunk.symbol) {
      const symType = symbol?.type ?? "symbol";
      console.log(`  ${chalk.gray(symType)} ${chalk.white.bold(chunk.symbol)}`);
    }
    console.log(
      chalk.gray(`  lines ${chunk.start}–${chunk.end}`) +
        "  " +
        chalk.gray(`score: ${score.toFixed(4)}`) +
        (tier !== "high" ? "  " + chalk.dim(`[${tier}]`) : ""),
    );

    // ── Dependency context ───────────────────────────────────────────────────
    if (tier !== "low") {
      const fileDeps = depGraph[chunk.file];
      const usedBy = importedByMap.get(chunk.file) ?? [];

      if (fileDeps?.imports.length) {
        const MAX_DEP_LINES = tier === "high" ? 6 : 3;
        const shown = fileDeps.imports.slice(0, MAX_DEP_LINES);
        const hidden = fileDeps.imports.length - shown.length;

        console.log(chalk.gray("  imports:"));
        for (const imp of shown) {
          const syms =
            imp.symbols.length > 0
              ? chalk.gray(
                  ` {${imp.symbols.slice(0, 4).join(", ")}${imp.symbols.length > 4 ? ", …" : ""}}`,
                )
              : "";
          console.log(`    ${chalk.gray("←")} ${chalk.blue(imp.file)}${syms}`);
        }
        if (hidden > 0) console.log(chalk.gray(`    … and ${hidden} more`));
      }

      if (usedBy.length > 0) {
        const MAX_USED_BY = tier === "high" ? 4 : 2;
        const shown = usedBy.slice(0, MAX_USED_BY);
        const hidden = usedBy.length - shown.length;

        console.log(chalk.gray("  used by (files):"));
        for (const caller of shown) {
          console.log(`    ${chalk.gray("→")} ${chalk.blue(caller)}`);
        }
        if (hidden > 0) console.log(chalk.gray(`    … and ${hidden} more`));
      }

      // Call Graph context
      const symbolId = chunk.symbol ? `${chunk.file}:${chunk.symbol}` : null;
      const callInfo = symbolId ? callGraph[symbolId] : null;

      if (callInfo) {
        if (callInfo.calls.length > 0) {
          const MAX_CALLS = tier === "high" ? 6 : 3;
          const shown = callInfo.calls.slice(0, MAX_CALLS);
          const hidden = callInfo.calls.length - shown.length;

          console.log(chalk.gray("  calls:"));
          for (const call of shown) {
            const loc = call.file ? chalk.gray(` (in ${call.file})`) : "";
            console.log(
              `    ${chalk.gray("●")} ${chalk.white(call.name)}${loc}`,
            );
          }
          if (hidden > 0) console.log(chalk.gray(`    … and ${hidden} more`));
        }

        if (callInfo.calledBy.length > 0) {
          const MAX_CALLERS = tier === "high" ? 4 : 2;
          const shown = callInfo.calledBy.slice(0, MAX_CALLERS);
          const hidden = callInfo.calledBy.length - shown.length;

          console.log(chalk.gray("  called by:"));
          for (const callerId of shown) {
            console.log(`    ${chalk.gray("○")} ${chalk.white(callerId)}`);
          }
          if (hidden > 0) console.log(chalk.gray(`    … and ${hidden} more`));
        }
      }
    }

    // ── Code / signature display ──────────────────────────────────────────────
    if (tier === "high") {
      console.log();
      const codeLines = chunk.content.split("\n");
      const limit = options.showCode ? codeLines.length : HIGH_CODE_LINES;
      const preview = codeLines.slice(0, limit);
      for (const line of preview) {
        console.log("  " + chalk.gray("│") + " " + line);
      }
      if (codeLines.length > limit) {
        console.log(
          "  " +
            chalk.gray(
              `│ … (${codeLines.length - limit} more lines — use --show-code to expand)`,
            ),
        );
      }
    } else if (tier === "med") {
      const sig = extractSignature(chunk.content);
      const sigLines = sig.split("\n");
      console.log();
      for (const line of sigLines) {
        console.log("  " + chalk.dim("≡") + " " + chalk.dim(line));
      }
    } else {
      // LOW tier: show AI-generated file summary if available.
      const fileSummary = fileSummaries[chunk.file];
      if (fileSummary) {
        console.log(
          "  " + chalk.dim("◦") + " " + chalk.dim(fileSummary.summary),
        );
      }
    }

    console.log();
    displayed++;
    if (displayed >= topK) break;
  }

  // ── Legend ─────────────────────────────────────────────────────────────────
  const legend = options.showCode
    ? chalk.gray(`Showing ${displayed} results (full code).`)
    : chalk.gray(
        `Showing ${displayed} results  ` +
          `(ranks 1–3: full code │ 4–7: signature [med] │ 8+: location [low]  ` +
          `--show-code for all)`,
      );
  console.log(legend);
}

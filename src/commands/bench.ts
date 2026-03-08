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
import { rerankResults } from "../search/rerank";
import { keywordSearch, vectorSearch } from "../search/vector";
import { EmbeddingCacheStorage } from "../storage/cache";
import { RepositoryStorage } from "../storage/repository";
import { SummaryStorage } from "../storage/summaries";
import { countTokensHeuristic, formatTokenStats } from "../utils/tokenizer";
import { generateContextString } from "./context";

export interface BenchOptions {
  topK?: number;
  keyword?: boolean;
  rerank?: boolean;
}

export async function runBench(
  rootDir: string,
  query: string,
  options: BenchOptions = {},
): Promise<void> {
  const config = loadConfig(rootDir);
  const repo = new RepositoryStorage(rootDir);
  const cacheStorage = new EmbeddingCacheStorage(config.projectId);
  const summaryStorage = new SummaryStorage(rootDir);

  const topK = options.topK ?? 5;
  const chunks = repo.loadChunks();
  const symbols = repo.loadSymbols();

  // Load graphs for "Full" context
  const depGraph: DependencyGraph = repo.loadDeps();
  const callGraph: CallGraph = repo.loadCallGraph();
  const fileSummaries: FileSummaryIndex = summaryStorage.hasFileSummaries()
    ? summaryStorage.loadFileSummaries()
    : {};
  const projectSummary = summaryStorage.loadProjectSummary();

  if (chunks.length === 0) {
    console.error(chalk.red("No index found. Run `ai-memory index` first."));
    process.exit(1);
  }

  console.log(
    chalk.bold(`\nBenchmarking token usage for: "${chalk.cyan(query)}"\n`),
  );

  // 1. Perform Search
  let results: SearchResult[] = [];
  const useKeyword = options.keyword || config.embedding.provider === "none";

  if (useKeyword) {
    results = keywordSearch(query, chunks, symbols, topK);
  } else {
    const spinner = ora("Searching...").start();
    try {
      const cache = cacheStorage.load();
      if (
        !cache ||
        (cache.chunkIds?.length === 0 &&
          Object.keys(cache.embeddings ?? {}).length === 0)
      ) {
        spinner.warn("No embeddings — falling back to keyword search.");
        results = keywordSearch(query, chunks, symbols, topK);
      } else {
        const provider = createEmbeddingProvider(config.embedding);
        const [queryEmbedding] = await provider.embed([query]);
        results = vectorSearch(queryEmbedding, chunks, cache, symbols, topK);
        if (results.length === 0)
          results = keywordSearch(query, chunks, symbols, topK);
        spinner.succeed("Search complete");
      }
    } catch (err) {
      spinner.fail(`Search failed: ${(err as Error).message}`);
      results = keywordSearch(query, chunks, symbols, topK);
    }
  }

  if (options.rerank && results.length > 0) {
    const rerankSpinner = ora("Reranking...").start();
    results = await rerankResults(query, results, topK);
    rerankSpinner.succeed("Reranking complete");
  }

  if (results.length === 0) {
    console.log(chalk.yellow("No results found to benchmark."));
    return;
  }

  // 2. Generate Contexts

  // Minimal: No deps, no call graph, no project summary
  const minimalContext = generateContextString(
    config,
    results,
    {}, // Empty dep graph
    {}, // Empty call graph
    {}, // No file summaries
    null, // No project summary
    { query, format: "markdown" },
    rootDir,
  );

  // Full: Everything included
  const fullContext = generateContextString(
    config,
    results,
    depGraph,
    callGraph,
    fileSummaries,
    projectSummary ? projectSummary.overview : null,
    { query, format: "markdown" },
    rootDir,
  );

  // 3. Compare
  const minTokens = countTokensHeuristic(minimalContext);
  const fullTokens = countTokensHeuristic(fullContext);
  const diff = fullTokens - minTokens;
  const percent = ((diff / minTokens) * 100).toFixed(1);

  // 4. Output Table
  console.log(chalk.bold("--- Token Comparison ---"));
  console.log(
    `${chalk.white("Mode")}               | ${chalk.white("Token Count")}      | ${chalk.white("Size (Approx)")}`,
  );
  console.log(`${"-".repeat(20)}+${"-".repeat(18)}+${"-".repeat(15)}`);

  console.log(
    `${chalk.green("Minimal (No tools)")}  | ${minTokens.toLocaleString().padEnd(16)} | ${(Buffer.byteLength(minimalContext) / 1024).toFixed(2).padStart(6)} KB`,
  );
  console.log(
    `${chalk.cyan("Full (With tools)")}     | ${fullTokens.toLocaleString().padEnd(16)} | ${(Buffer.byteLength(fullContext) / 1024).toFixed(2).padStart(6)} KB`,
  );

  console.log(`${"-".repeat(20)}+${"-".repeat(18)}+${"-".repeat(15)}`);
  console.log(
    `${chalk.bold("Overhead:")}           | ${chalk.yellow("+" + diff.toLocaleString().padEnd(15))} | ${chalk.yellow("+" + percent + "%")}`,
  );
  console.log();

  console.log(
    chalk.gray(`* Tokens estimated using heuristic (~3.2 chars/token).`),
  );
  console.log(
    chalk.gray(
      `* Advanced tools include: Project Overview, Dependencies, and Call Graph.`,
    ),
  );
  console.log();
}

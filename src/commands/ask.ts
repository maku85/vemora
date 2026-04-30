import chalk from "chalk";
import ora from "ora";
import { loadConfig } from "../core/config";
import type {
  CallGraph,
  DependencyGraph,
  FileSummaryIndex,
  KnowledgeEntry,
  SearchResult,
  SummarizationConfig,
} from "../core/types";
import { createEmbeddingProvider } from "../embeddings/factory";
import { createLLMProvider } from "../llm/factory";
import { tersifyPrompt } from "../llm/terse";
import { computeBM25Scores } from "../search/bm25";
import { hybridSearch } from "../search/hybrid";
import { vectorSearch } from "../search/vector";
import { EmbeddingCacheStorage } from "../storage/cache";
import { KnowledgeStorage } from "../storage/knowledge";
import { RepositoryStorage } from "../storage/repository";
import { SummaryStorage } from "../storage/summaries";
import { applyTokenBudget } from "../utils/tokenizer";
import { generateContextString } from "./context";

export interface AskOptions {
  /** Number of code chunks to retrieve (default: 5) */
  topK?: number;
  /** Force keyword/BM25 search, skip embeddings */
  keyword?: boolean;
  /** Use hybrid vector+BM25 search */
  hybrid?: boolean;
  /** Max tokens for retrieved context (default: 6000) */
  budget?: number;
  /** Print the retrieved context before the answer */
  showContext?: boolean;
  /** Inject a brevity constraint into the system prompt (~50-70% output token reduction) */
  terse?: boolean;
}

const SYSTEM_PROMPT =
  "You are an expert software engineer assistant. " +
  "Answer the user's question accurately and concisely based on the code context provided. " +
  "Reference specific files and symbols when relevant. " +
  "If the context does not contain enough information to answer, say so clearly.";

export async function runAsk(
  rootDir: string,
  question: string,
  options: AskOptions = {},
): Promise<void> {
  const config = loadConfig(rootDir);

  if (!config.summarization) {
    console.error(
      chalk.red(
        'No LLM configured. Add a "summarization" block to .vemora/config.json.\n\n' +
          "  Example for Ollama:\n" +
          '    "summarization": { "provider": "ollama", "model": "qwen2.5-coder:14b" }\n\n' +
          "  Example for OpenAI:\n" +
          '    "summarization": { "provider": "openai", "model": "gpt-4o-mini" }',
      ),
    );
    process.exit(1);
  }

  const repo = new RepositoryStorage(rootDir);
  const cacheStorage = new EmbeddingCacheStorage(config.projectId);
  const summaryStorage = new SummaryStorage(rootDir);

  const topK = options.topK ?? 5;
  const budget = options.budget ?? 6000;

  const chunks = repo.loadChunks();
  const symbols = repo.loadSymbols();
  const depGraph: DependencyGraph = repo.loadDeps();
  const callGraph: CallGraph = repo.loadCallGraph();
  const fileSummaries: FileSummaryIndex = summaryStorage.hasFileSummaries()
    ? summaryStorage.loadFileSummaries()
    : {};
  const projectSummary = summaryStorage.loadProjectSummary();
  const knowledgeEntries: KnowledgeEntry[] = new KnowledgeStorage(
    rootDir,
  ).load();

  if (chunks.length === 0) {
    console.error(chalk.red("No index found. Run `vemora index` first."));
    process.exit(1);
  }

  // ── Retrieve context ──────────────────────────────────────────────────────

  let results: SearchResult[] = [];
  const forceKeyword =
    options.keyword || config.embedding.provider === "none";

  if (forceKeyword && !options.hybrid) {
    results = computeBM25Scores(question, chunks, symbols, topK);
  } else {
    const spinner = ora("Retrieving context...").start();
    try {
      const cache = cacheStorage.load();
      const cachedCount = cache
        ? (cache.chunkIds?.length ??
          Object.keys(cache.embeddings ?? {}).length)
        : 0;

      if (!cache || cachedCount === 0) {
        spinner.warn("No embeddings found — falling back to keyword search.");
        results = computeBM25Scores(question, chunks, symbols, topK);
      } else {
        const provider = createEmbeddingProvider(config.embedding);
        const [queryEmbedding] = await provider.embed([question]);

        if (options.hybrid) {
          results = await hybridSearch(
            question,
            queryEmbedding,
            chunks,
            cache,
            symbols,
            { topK },
          );
        } else {
          results = vectorSearch(queryEmbedding, chunks, cache, symbols, topK);
          if (results.length === 0) {
            results = computeBM25Scores(question, chunks, symbols, topK);
          }
        }
        spinner.succeed("Context retrieved");
      }
    } catch (err) {
      spinner.fail(`Search failed: ${(err as Error).message}`);
      results = computeBM25Scores(question, chunks, symbols, topK);
    }
  }

  results = applyTokenBudget(results, budget);

  // ── Build context string ──────────────────────────────────────────────────

  const contextFormat =
    config.display?.format === "terse" ? "terse" : "plain";

  const contextStr = generateContextString(
    config,
    results,
    depGraph,
    callGraph,
    fileSummaries,
    projectSummary?.overview ?? null,
    { query: question, format: contextFormat },
    rootDir,
    chunks,
    knowledgeEntries,
  );

  if (options.showContext) {
    console.log(chalk.gray("─── Retrieved Context ──────────────────────────"));
    console.log(chalk.gray(contextStr));
    console.log(chalk.gray("────────────────────────────────────────────────\n"));
  }

  // ── Call LLM ──────────────────────────────────────────────────────────────

  const llmConfig: SummarizationConfig = {
    ...config.summarization,
    model: config.summarization.model,
  };

  const llm = createLLMProvider(llmConfig);

  console.log(chalk.gray(`\n[${llm.name} · ${llmConfig.model}]\n`));

  let tokensWritten = 0;

  try {
    const response = await llm.chat(
      [
        {
          role: "system",
          content: `${options.terse ? tersifyPrompt(SYSTEM_PROMPT) : SYSTEM_PROMPT}\n\n${contextStr}`,
        },
        { role: "user", content: question },
      ],
      {
        model: llmConfig.model,
        stream: true,
        onToken: (token: string) => {
          process.stdout.write(token);
          tokensWritten++;
        },
      },
    );

    // Fallback: if provider doesn't support streaming, print the full response.
    if (tokensWritten === 0 && response.content) {
      process.stdout.write(response.content);
    }

    process.stdout.write("\n");

    if (response.usage) {
      console.log(
        chalk.gray(
          `\n[${response.usage.promptTokens} prompt + ${response.usage.completionTokens} completion tokens]`,
        ),
      );
    }
  } catch (err) {
    console.error(chalk.red("\nLLM error:"), (err as Error).message);
    process.exit(1);
  }
}

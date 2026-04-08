import chalk from "chalk";
import ora from "ora";
import readline from "readline";
import { loadConfig } from "../core/config";
import type {
  CallGraph,
  DependencyGraph,
  FileSummaryIndex,
  SearchResult,
  SummarizationConfig,
} from "../core/types";
import { createEmbeddingProvider } from "../embeddings/factory";
import { computeImportedBy } from "../indexer/deps";
import { createLLMProvider } from "../llm/factory";
import type { ChatMessage } from "../llm/provider";
import { computeBM25Scores } from "../search/bm25";
import { formatMarkdown } from "../search/formatter";
import { hybridSearch } from "../search/hybrid";
import { rerankResults } from "../search/rerank";
import { keywordSearch, vectorSearch } from "../search/vector";
import { EmbeddingCacheStorage } from "../storage/cache";
import { RepositoryStorage } from "../storage/repository";
import { SummaryStorage } from "../storage/summaries";

export interface ChatOptions {
  provider?: string;
  model?: string;
  topK?: number;
}

export async function runChat(
  rootDir: string,
  options: ChatOptions = {},
): Promise<void> {
  const config = loadConfig(rootDir);
  const repo = new RepositoryStorage(rootDir);
  const cacheStorage = new EmbeddingCacheStorage(config.projectId);
  const summaryStorage = new SummaryStorage(rootDir);

  const chunks = repo.loadChunks();
  const symbols = repo.loadSymbols();
  const depGraph: DependencyGraph = repo.loadDeps();
  const callGraph: CallGraph = repo.loadCallGraph();
  const fileSummaries: FileSummaryIndex = summaryStorage.hasFileSummaries()
    ? summaryStorage.loadFileSummaries()
    : {};
  const projectSummary = summaryStorage.loadProjectSummary();

  const llmConfig: SummarizationConfig = {
    ...(config.summarization ?? { provider: "ollama" as const, model: "gemma4:e2b", baseUrl: "http://localhost:11434" }),
    ...(options.provider ? { provider: options.provider as SummarizationConfig["provider"] } : {}),
    ...(options.model ? { model: options.model } : {}),
  };

  const llm = createLLMProvider(llmConfig);
  const history: ChatMessage[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.blue.bold("You > "),
  });

  console.log(chalk.bold("\nWelcome to vemora chat!"));
  console.log(chalk.gray(`Project: ${config.projectName}`));
  console.log(
    chalk.gray(
      'Type your question about the codebase. Type "exit" or "quit" to stop.\n',
    ),
  );

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input.toLowerCase() === "exit" || input.toLowerCase() === "quit") {
      rl.close();
      return;
    }

    // 1. Search for context based on user input
    const spinner = ora("Searching for context...").start();
    let contextStr = "";

    try {
      let results: SearchResult[] = [];
      const useKeyword = config.embedding.provider === "none";

      if (useKeyword) {
        results = computeBM25Scores(input, chunks, symbols, options.topK || 5);
      } else {
        const cache = cacheStorage.load();
        if (
          cache &&
          (cache.chunkIds?.length || Object.keys(cache.embeddings ?? {}).length)
        ) {
          const provider = createEmbeddingProvider(config.embedding);
          const [queryEmbedding] = await provider.embed([input]);

          // Use hybrid search for better quality
          results = await hybridSearch(
            input,
            queryEmbedding,
            chunks,
            cache,
            symbols,
            {
              topK: 25, // Get more for reranking
            },
          );

          // Always rerank for chat to ensure best quality
          results = await rerankResults(input, results, options.topK || 5, config.reranker, config.summarization?.model);
        } else {
          results = computeBM25Scores(
            input,
            chunks,
            symbols,
            options.topK || 5,
          );
        }
      }

      contextStr = formatMarkdown(
        input,
        results,
        depGraph,
        fileSummaries,
        callGraph,
        {
          // Pass callGraph here
          format: "markdown",
          topK: options.topK || 5,
        },
      );

      spinner.succeed("Context found");
    } catch (err) {
      spinner.fail(`Context search failed: ${(err as Error).message}`);
    }

    // 2. Build the prompt
    // We inject the project summary and the specific relevant code found
    const systemPrompt = `You are an expert software engineer assistant. 
You have access to the following project context to help you answer:

${projectSummary ? `PROJECT OVERVIEW:\n${projectSummary.overview}\n\n` : ""}
RELEVANT CODE CHUNKS:
${contextStr}

Use this context to provide accurate, specific, and helpful answers about the codebase.
If the information is not in the context, be honest about it.`;

    // 3. Prepare message history
    // For now, we update the system prompt per message to reflect new context
    // This is a simple implementation; a better one would prune old context
    const currentMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: input },
    ];

    // 4. Call LLM
    const llmSpinner = ora("LLM is thinking...").start();
    try {
      let fullResponse = "";
      process.stdout.write(`\n${chalk.green.bold("AI >")} `);

      await llm.chat(currentMessages, {
        model: llmConfig.model,
        onToken: (token) => {
          if (llmSpinner.isSpinning) {
            llmSpinner.stop();
          }
          process.stdout.write(token);
          fullResponse += token;
        },
      });

      if (llmSpinner.isSpinning) {
        llmSpinner.stop();
      }
      console.log("\n");

      // Update history
      history.push({ role: "user", content: input });
      history.push({ role: "assistant", content: fullResponse });

      // Limit history to last 10 messages to avoid token bloat
      if (history.length > 10) {
        history.splice(0, 2);
      }
    } catch (err) {
      if (llmSpinner.isSpinning) {
        llmSpinner.fail(`LLM call failed: ${(err as Error).message}`);
      } else {
        console.error(
          chalk.red(`\nLLM call failed: ${(err as Error).message}`),
        );
      }
    }

    rl.prompt();
  }).on("close", () => {
    console.log(chalk.bold("\nGoodbye!"));
    process.exit(0);
  });
}

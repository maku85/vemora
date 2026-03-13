import chalk from "chalk";
import path from "path";
import { loadConfig } from "../core/config";
import { detectCycles } from "../indexer/deps";
import { EmbeddingCacheStorage } from "../storage/cache";
import { KnowledgeStorage } from "../storage/knowledge";
import { RepositoryStorage } from "../storage/repository";
import { SummaryStorage } from "../storage/summaries";

export async function runStatus(rootDir: string): Promise<void> {
  const config = loadConfig(rootDir);
  const repo = new RepositoryStorage(rootDir);
  const meta = repo.loadMetadata();
  const cacheStorage = new EmbeddingCacheStorage(config.projectId);
  const cache = cacheStorage.load();

  const row = (label: string, value: string) =>
    console.log(`  ${chalk.gray(label.padEnd(16))} ${value}`);

  console.log(chalk.bold("vemora status"));
  console.log();
  row("Project:", config.projectName);
  row("Project ID:", config.projectId);
  row("Provider:", `${config.embedding.provider} / ${config.embedding.model}`);

  if (meta) {
    console.log();
    console.log(chalk.bold("Index (versioned in git):"));
    row("Last indexed:", meta.lastIndexed ?? chalk.gray("never"));
    row("Files:", String(meta.indexedFiles));
    row("Chunks:", String(meta.totalChunks));
    row("Symbols:", String(meta.totalSymbols));
    row("Dep edges:", String(meta.totalDepEdges ?? 0));
    row("Call edges:", String(meta.totalCallEdges ?? 0));
  }

  // Summaries
  const summaryStorage = new SummaryStorage(rootDir);
  if (summaryStorage.hasFileSummaries()) {
    const fileSummaries = summaryStorage.loadFileSummaries();
    const summaryCount = Object.keys(fileSummaries).length;
    const hasOverview = summaryStorage.hasProjectSummary();
    console.log();
    console.log(chalk.bold("Summaries (versioned in git):"));
    row("File summaries:", String(summaryCount));
    row(
      "Project overview:",
      hasOverview
        ? chalk.green("yes")
        : chalk.gray("no  (run vemora summarize)"),
    );
  }

  // Knowledge store
  const knowledgeStorage = new KnowledgeStorage(rootDir);
  if (knowledgeStorage.hasKnowledge()) {
    const entries = knowledgeStorage.load();
    console.log();
    console.log(chalk.bold("Knowledge store (versioned in git):"));
    row("Entries:", String(entries.length));

    // Staleness detection: warn if relatedFiles were modified after entry was created
    const fileIndex = repo.loadFiles();
    const stale = entries.filter((e) => {
      if (!e.relatedFiles?.length) return false;
      return e.relatedFiles.some((f) => {
        const fileEntry = fileIndex[f];
        if (!fileEntry) return false;
        // If we have a hash snapshot, use it — immune to touch/timestamp skew
        if (e.relatedFileHashes?.[f]) {
          return fileEntry.hash !== e.relatedFileHashes[f];
        }
        // Fallback for older entries without hash snapshots
        if (fileEntry.hash && e.createdAt) {
          return new Date(fileEntry.lastModified) > new Date(e.createdAt);
        }
        return false;
      });
    });

    if (stale.length > 0) {
      console.log();
      for (const e of stale) {
        console.log(
          `  ${chalk.yellow("⚠")}  Knowledge entry ${chalk.gray(`[${e.id.slice(0, 8)}]`)} ${chalk.bold(`"${e.title}"`)} — related files changed after entry was created`,
        );
        console.log(
          chalk.gray(
            `     Created: ${e.createdAt.slice(0, 10)} · Run \`vemora knowledge list\` to review`,
          ),
        );
      }
    }
  }

  // TODO / FIXME annotations
  const todos = repo.loadTodos();
  if (todos.length > 0) {
    const byType = todos.reduce<Record<string, number>>((acc, t) => {
      acc[t.type] = (acc[t.type] ?? 0) + 1;
      return acc;
    }, {});
    console.log();
    console.log(chalk.bold("Code annotations (versioned in git):"));
    row("Total:", String(todos.length));
    for (const [type, count] of Object.entries(byType).sort()) {
      row(`  ${type}:`, String(count));
    }
  }

  // Circular dependency detection
  const deps = repo.loadDeps();
  const cycles = detectCycles(deps);
  if (cycles.length > 0) {
    console.log();
    console.log(chalk.bold("Circular dependencies:"));
    for (const cycle of cycles) {
      const display = cycle
        .map((f) => chalk.cyan(path.basename(f)))
        .join(chalk.gray(" → "));
      console.log(`  ${chalk.yellow("⚠")}  ${display}`);
    }
  }

  console.log();
  console.log(chalk.bold("Embedding cache (local only):"));
  const cachedCount = cache?.chunkIds
    ? cache.chunkIds.length
    : Object.keys(cache?.embeddings ?? {}).length;
  if (!cache || cachedCount === 0) {
    console.log(
      `  ${chalk.gray("No cache found.")} Run ${chalk.cyan("vemora index")} to generate embeddings.`,
    );
  } else {
    row("Cached vectors:", String(cachedCount));
    row("Model:", cache.embeddingModel);
    row("Updated:", cache.lastUpdated);
    row("Location:", cacheStorage.getCacheDir());
  }
}

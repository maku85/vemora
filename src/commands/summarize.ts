import chalk from "chalk";
import fs from "fs";
import ora from "ora";
import path from "path";
import { loadConfig } from "../core/config";
import type { FileSummaryIndex, ProjectSummary } from "../core/types";
import { createLLMProvider } from "../llm/factory";
import { RepositoryStorage } from "../storage/repository";
import { SummaryStorage } from "../storage/summaries";

export interface SummarizeOptions {
  /** Re-generate all summaries, ignoring content hashes */
  force?: boolean;
  /** Override the model from config (e.g. gpt-4o, gpt-4o-mini) */
  model?: string;
  /** Only generate file-level summaries, skip project overview */
  filesOnly?: boolean;
  /** Only (re)generate the project overview from existing file summaries */
  projectOnly?: boolean;
  /** Print the existing project overview without regenerating anything */
  show?: boolean;
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

function fileSummaryPrompt(
  file: string,
  symbols: string[],
  content: string,
): string {
  const symbolList = symbols.length > 0 ? symbols.join(", ") : "none";
  return (
    `Summarize this source file in 1-2 sentences for a code memory index.\n` +
    `Cover: what it does, key exports (${symbolList}), its role in the codebase.\n` +
    `Output only the summary sentence(s). No headers, no lists, no preamble.\n\n` +
    `File: ${file}\n\`\`\`\n${content}\n\`\`\``
  );
}

function projectOverviewPrompt(projectName: string, summaries: string): string {
  return (
    `Write a technical overview of the "${projectName}" codebase for an AI assistant's memory index.\n` +
    `Cover: purpose, main architectural layers, key data flows, entry points for development tasks.\n` +
    `Be dense and precise. 200-300 words. No preamble, no headers, plain prose only.\n\n` +
    `File summaries:\n${summaries}`
  );
}

// ─── Main command ─────────────────────────────────────────────────────────────

export async function runSummarize(
  rootDir: string,
  options: SummarizeOptions = {},
): Promise<void> {
  if (options.show) {
    const summaryStorage = new SummaryStorage(rootDir);
    const projectSummary = summaryStorage.loadProjectSummary();
    if (!projectSummary) {
      console.log(chalk.yellow("No project overview found. Run `vemora summarize` first."));
      process.exit(1);
    }
    console.log(projectSummary.overview);
    console.log();
    console.log(chalk.gray(`Generated: ${projectSummary.generatedAt}`));
    return;
  }

  const config = loadConfig(rootDir);
  const repo = new RepositoryStorage(rootDir);
  const summaryStorage = new SummaryStorage(rootDir);

  // ── Resolve LLM provider ────────────────────────────────────────────────────
  const summarizationConfig = {
    ...(config.summarization ?? { provider: "ollama" as const, model: "gemma4:e2b", baseUrl: "http://localhost:11434" }),
    ...(options.model ? { model: options.model } : {}),
  };
  const model = summarizationConfig.model;
  const llm = createLLMProvider(summarizationConfig);

  // ── File summaries ──────────────────────────────────────────────────────────

  let anyFileSummaryChanged = false;

  if (!options.projectOnly) {
    const files = repo.loadFiles();
    const prevSummaries = summaryStorage.loadFileSummaries();

    const allEntries = Object.entries(files);
    const toSummarize = options.force
      ? allEntries
      : allEntries.filter(([relPath, entry]) => {
          const prev = prevSummaries[relPath];
          return !prev || prev.contentHash !== entry.hash;
        });

    const skipped = allEntries.length - toSummarize.length;

    console.log(chalk.bold(`Summarizing ${chalk.cyan(config.projectName)}`));
    console.log(chalk.gray(`  model: ${model}`));
    console.log();
    console.log(
      chalk.bold("File summaries") +
        chalk.gray(
          `  ${toSummarize.length} to generate` +
            (skipped > 0 ? `, ${skipped} unchanged (skipped)` : ""),
        ),
    );
    console.log();

    if (toSummarize.length === 0) {
      console.log(chalk.green("✓ All file summaries are up to date."));
    } else {
      const updated: FileSummaryIndex = { ...prevSummaries };
      let failed = 0;

      for (let i = 0; i < toSummarize.length; i++) {
        const [relPath, entry] = toSummarize[i];
        const label = `[${i + 1}/${toSummarize.length}] ${relPath}`;
        const spinner = ora(chalk.gray(label)).start();

        try {
          // Read file content, truncate to ~4000 chars to stay within prompt limits
          const absolutePath = path.join(rootDir, relPath);
          let content = "";
          if (fs.existsSync(absolutePath)) {
            const raw = fs.readFileSync(absolutePath, "utf-8");
            content =
              raw.length > 4000
                ? raw.slice(0, 4000) + "\n... (truncated)"
                : raw;
          }

          const fileSymbols = entry.symbols ?? [];

          const response = await llm.chat(
            [{ role: "user", content: fileSummaryPrompt(relPath, fileSymbols, content) }],
            { model, maxTokens: 1024, temperature: 0 },
          );

          const summary = response.content.trim();

          updated[relPath] = {
            summary,
            contentHash: entry.hash,
            generatedAt: new Date().toISOString(),
          };

          // Save after every file so progress is never lost on interruption
          summaryStorage.saveFileSummaries(updated);
          spinner.succeed(chalk.gray(relPath));
          anyFileSummaryChanged = true;
        } catch (err) {
          spinner.fail(chalk.red(`${relPath}: ${(err as Error).message}`));
          failed++;
        }
      }

      console.log();
      console.log(
        chalk.green(`✓ ${toSummarize.length - failed} file summaries saved`) +
          (failed > 0 ? chalk.red(` (${failed} failed)`) : "") +
          chalk.gray("  →  .vemora/summaries/file-summaries.json"),
      );
    }

    if (options.filesOnly) return;
    console.log();
  }

  // ── Project overview ────────────────────────────────────────────────────────

  if (
    !anyFileSummaryChanged &&
    !options.force &&
    !options.projectOnly &&
    summaryStorage.hasProjectSummary()
  ) {
    console.log(chalk.green("✓ Project overview is up to date."));
    return;
  }

  const currentSummaries = summaryStorage.loadFileSummaries();
  const summaryEntries = Object.entries(currentSummaries);

  if (summaryEntries.length === 0) {
    console.log(
      chalk.yellow(
        "No file summaries found. Run `vemora summarize` (without --project-only) first.",
      ),
    );
    return;
  }

  const overviewSpinner = ora("Generating project overview...").start();

  // Build the file summaries block, sorted and truncated to fit context
  const MAX_SUMMARY_CHARS = 12000;
  let summaryBlock = summaryEntries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, { summary }]) => `${file}:\n  ${summary}`)
    .join("\n\n");

  if (summaryBlock.length > MAX_SUMMARY_CHARS) {
    summaryBlock =
      summaryBlock.slice(0, MAX_SUMMARY_CHARS) + "\n... (truncated)";
  }

  try {
    const response = await llm.chat(
      [{ role: "user", content: projectOverviewPrompt(config.projectName, summaryBlock) }],
      { model, maxTokens: 2048, temperature: 0.1 },
    );

    const overview = response.content.trim();

    const projectSummary: ProjectSummary = {
      overview,
      generatedAt: new Date().toISOString(),
    };

    summaryStorage.saveProjectSummary(projectSummary);
    overviewSpinner.succeed(
      "Project overview saved" +
        chalk.gray("  →  .vemora/summaries/project-summary.json"),
    );

    // Print a short preview
    console.log();
    const previewLines = overview.split("\n").slice(0, 5);
    for (const line of previewLines) {
      console.log("  " + chalk.gray(line));
    }
    if (overview.split("\n").length > 5) {
      console.log(chalk.gray("  … (use `vemora summarize --show` to read in full)"));
    }
  } catch (err) {
    overviewSpinner.fail(`Project overview failed: ${(err as Error).message}`);
  }
}

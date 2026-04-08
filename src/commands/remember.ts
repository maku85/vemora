import chalk from "chalk";
import crypto from "crypto";
import { loadConfig } from "../core/config";
import { createLLMProvider } from "../llm/factory";
import type { KnowledgeEntry } from "../core/types";
import { KnowledgeStorage } from "../storage/knowledge";
import { RepositoryStorage } from "../storage/repository";

export interface RememberOptions {
  category?: "decision" | "pattern" | "gotcha" | "glossary";
  title?: string;
  files?: string;
  symbols?: string;
  confidence?: "high" | "medium" | "low";
  createdBy?: string;
  supersedes?: string;
}

const VALID_CATEGORIES = ["decision", "pattern", "gotcha", "glossary"] as const;
type Category = (typeof VALID_CATEGORIES)[number];

/**
 * Calls the configured LLM to classify a knowledge entry body into one of the
 * four categories. Falls back to "pattern" if the LLM is unavailable or returns
 * an unexpected value.
 */
async function classifyCategory(
  body: string,
  config: ReturnType<typeof loadConfig>,
): Promise<Category> {
  const llmConfig = config.summarization ?? config.planner;
  if (!llmConfig) return "pattern";
  try {
    const provider = createLLMProvider(llmConfig);
    const resp = await provider.chat([
      {
        role: "system",
        content:
          "You are a classifier. Given a short knowledge note about a software project, " +
          "reply with exactly one word — the best category for the note:\n" +
          "- decision  (an architectural or design choice and its rationale)\n" +
          "- pattern   (an approved implementation pattern or convention)\n" +
          "- gotcha    (a surprising behaviour, constraint, or known trap)\n" +
          "- glossary  (a definition or explanation of a term used in the project)\n" +
          "Reply with only the single category word, nothing else.",
      },
      { role: "user", content: body.slice(0, 500) },
    ]);
    const word = resp.content.trim().toLowerCase() as Category;
    return VALID_CATEGORIES.includes(word) ? word : "pattern";
  } catch {
    return "pattern";
  }
}

export async function runRemember(
  rootDir: string,
  body: string,
  options: RememberOptions = {},
): Promise<void> {
  const config = loadConfig(rootDir);

  if (body.trim().length < 20) {
    console.error(
      chalk.red("Error: knowledge entry must be at least 20 characters."),
    );
    process.exit(1);
  }

  const storage = new KnowledgeStorage(rootDir);
  const repo = new RepositoryStorage(rootDir);
  const fileIndex = repo.loadFiles();
  const entries = storage.load();

  // Warn if a similar entry already exists (simple token overlap)
  const bodyTokens = new Set(
    body
      .toLowerCase()
      .split(/[\s\W]+/)
      .filter((t) => t.length >= 3),
  );
  const similar = entries.find((e) => {
    const eTokens = `${e.title} ${e.body}`
      .toLowerCase()
      .split(/[\s\W]+/)
      .filter((t) => t.length >= 3);
    const overlap = eTokens.filter((t) => bodyTokens.has(t)).length;
    return overlap / Math.max(bodyTokens.size, 1) > 0.6;
  });

  if (similar) {
    console.warn(
      chalk.yellow(
        `⚠  Similar entry already exists: [${similar.id.slice(0, 8)}] "${similar.title}"`,
      ),
    );
    console.warn(
      chalk.gray(
        "   Use --supersedes <id> to replace it, or proceed to add a new entry.",
      ),
    );
  }

  // Derive title from body if not provided (first sentence, max 80 chars)
  const title =
    options.title ??
    body
      .split(/[.!?\n]/)[0]
      .trim()
      .slice(0, 80);

  // Auto-classify category via LLM when not explicitly provided
  let category: Category;
  if (options.category) {
    category = options.category;
  } else {
    const spinner = (await import("ora")).default("Classifying…").start();
    try {
      category = await classifyCategory(body, config);
      spinner.stop();
    } catch {
      spinner.stop();
      category = "pattern";
    }
  }

  const entry: KnowledgeEntry = {
    id: crypto.randomUUID(),
    category,
    title,
    body: body.trim(),
    relatedFiles: options.files
      ? options.files
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean)
      : undefined,
    relatedFileHashes: options.files
      ? Object.fromEntries(
          options.files
            .split(",")
            .map((f) => f.trim())
            .filter(Boolean)
            .flatMap((f) => {
              const entry = fileIndex[f];
              return entry?.hash ? [[f, entry.hash]] : [];
            }),
        )
      : undefined,
    relatedSymbols: options.symbols
      ? options.symbols
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    createdAt: new Date().toISOString(),
    createdBy: options.createdBy ?? "human",
    confidence: options.confidence ?? "medium",
    supersedes: options.supersedes,
  };

  storage.add(entry);

  console.log(chalk.green("✔ Knowledge entry saved."));
  console.log(`  ${chalk.gray("ID:")}       ${entry.id}`);
  console.log(`  ${chalk.gray("Category:")} ${entry.category}`);
  console.log(`  ${chalk.gray("Title:")}    ${entry.title}`);
  if (entry.relatedFiles?.length) {
    console.log(
      `  ${chalk.gray("Files:")}    ${entry.relatedFiles.join(", ")}`,
    );
  }
  if (entry.relatedSymbols?.length) {
    console.log(
      `  ${chalk.gray("Symbols:")} ${entry.relatedSymbols.join(", ")}`,
    );
  }
  if (entry.supersedes) {
    console.log(`  ${chalk.gray("Supersedes:")} ${entry.supersedes}`);
  }
}

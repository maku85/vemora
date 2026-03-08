import chalk from "chalk";
import crypto from "crypto";
import { loadConfig } from "../core/config";
import type { KnowledgeEntry } from "../core/types";
import { KnowledgeStorage } from "../storage/knowledge";

export interface RememberOptions {
  category?: "decision" | "pattern" | "gotcha" | "glossary";
  title?: string;
  files?: string;
  symbols?: string;
  confidence?: "high" | "medium" | "low";
  createdBy?: string;
  supersedes?: string;
}

export async function runRemember(
  rootDir: string,
  body: string,
  options: RememberOptions = {},
): Promise<void> {
  loadConfig(rootDir); // validate project is initialized

  if (body.trim().length < 20) {
    console.error(
      chalk.red("Error: knowledge entry must be at least 20 characters."),
    );
    process.exit(1);
  }

  const storage = new KnowledgeStorage(rootDir);
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

  const entry: KnowledgeEntry = {
    id: crypto.randomUUID(),
    category: options.category ?? "pattern",
    title,
    body: body.trim(),
    relatedFiles: options.files
      ? options.files
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean)
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

import chalk from "chalk";
import crypto from "crypto";
import readline from "readline";
import { loadConfig } from "../core/config";
import { createLLMProvider } from "../llm/factory";
import type { KnowledgeEntry } from "../core/types";
import { KnowledgeStorage, filterValidAt } from "../storage/knowledge";
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
 * Uses the configured LLM to check whether `newBody` directly contradicts any
 * of the candidate entries. Returns the contradicting entry or null.
 * Only fires when candidates exist — no overhead on the common case.
 */
async function detectContradiction(
  newBody: string,
  candidates: KnowledgeEntry[],
  config: ReturnType<typeof loadConfig>,
): Promise<KnowledgeEntry | null> {
  const llmConfig = config.summarization ?? config.planner;
  if (!llmConfig) return null;
  try {
    const provider = createLLMProvider(llmConfig);
    const candidateList = candidates
      .map((c, i) => `[${i + 1}] (${c.id.slice(0, 8)}) ${c.title}: ${c.body.slice(0, 200)}`)
      .join("\n");
    const resp = await provider.chat(
      [
        {
          role: "system",
          content:
            "You are a fact-checker for a software project knowledge base. " +
            "Given a new note and a list of existing notes, determine if the new note " +
            "DIRECTLY CONTRADICTS any existing note (i.e. they cannot both be true at the same time). " +
            "An update or refinement to a fact is NOT a contradiction. " +
            "Reply with ONLY the number of the contradicting entry (e.g. '2'), or '0' if there is no contradiction.",
        },
        {
          role: "user",
          content: `New note: ${newBody}\n\nExisting notes:\n${candidateList}`,
        },
      ],
      { maxTokens: 8, temperature: 0 },
    );
    const idx = parseInt(resp.content.trim(), 10);
    if (isNaN(idx) || idx <= 0 || idx > candidates.length) return null;
    return candidates[idx - 1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Prompts the user interactively for how to handle a detected contradiction.
 * Returns "supersede" | "keep" | "abort".
 * Falls back to "keep" when not running in a TTY (CI / pipe).
 */
async function promptContradictionChoice(
  newBody: string,
  conflict: KnowledgeEntry,
): Promise<"supersede" | "keep" | "abort"> {
  if (!process.stdin.isTTY) return "keep";

  console.warn();
  console.warn(chalk.yellow(`⚠  Possible contradiction with existing entry [${conflict.id.slice(0, 8)}] "${conflict.title}"`));
  console.warn(chalk.gray(`   Existing: ${conflict.body.slice(0, 120)}${conflict.body.length > 120 ? "…" : ""}`));
  console.warn(chalk.gray(`   New:      ${newBody.slice(0, 120)}${newBody.length > 120 ? "…" : ""}`));
  console.warn();
  console.warn("   Options:");
  console.warn(`     ${chalk.cyan("[s]")} invalidate existing + save new (recommended)`);
  console.warn(`     ${chalk.cyan("[k]")} keep both entries`);
  console.warn(`     ${chalk.cyan("[a]")} abort`);
  console.warn();

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Choice [s/k/a]: ", (answer) => {
      rl.close();
      const ch = answer.trim().toLowerCase();
      if (ch === "s") return resolve("supersede");
      if (ch === "a") return resolve("abort");
      resolve("keep");
    });
  });
}

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
  const validEntries = filterValidAt(entries);

  // Token overlap pre-filter — collect candidates for contradiction check (>0.4)
  // and warn on near-duplicates (>0.6)
  const bodyTokens = new Set(
    body
      .toLowerCase()
      .split(/[\s\W]+/)
      .filter((t) => t.length >= 3),
  );
  const candidates: KnowledgeEntry[] = [];
  for (const e of validEntries) {
    const eTokens = `${e.title} ${e.body}`
      .toLowerCase()
      .split(/[\s\W]+/)
      .filter((t) => t.length >= 3);
    const overlap = eTokens.filter((t) => bodyTokens.has(t)).length / Math.max(bodyTokens.size, 1);
    if (overlap > 0.6) {
      console.warn(chalk.yellow(`⚠  Similar entry already exists: [${e.id.slice(0, 8)}] "${e.title}"`));
      console.warn(chalk.gray("   Use --supersedes <id> to replace it, or proceed to add a new entry."));
    } else if (overlap > 0.4) {
      candidates.push(e);
    }
  }

  // Contradiction detection via LLM (only when candidates exist)
  let supersedingId: string | undefined;
  if (candidates.length > 0) {
    const spinner = (await import("ora")).default("Checking for contradictions…").start();
    const conflict = await detectContradiction(body, candidates, config);
    spinner.stop();

    if (conflict) {
      const choice = await promptContradictionChoice(body, conflict);
      if (choice === "abort") {
        console.log(chalk.gray("Aborted — no entry saved."));
        return;
      }
      if (choice === "supersede") {
        storage.invalidate(conflict.id);
        supersedingId = conflict.id;
        console.log(chalk.gray(`  Invalidated [${conflict.id.slice(0, 8)}] "${conflict.title}"`));
      }
    }
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
    supersedes: options.supersedes ?? supersedingId,
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

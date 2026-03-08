import chalk from "chalk";
import { loadConfig } from "../core/config";
import type { KnowledgeEntry } from "../core/types";
import { KnowledgeStorage } from "../storage/knowledge";

// ─── List ─────────────────────────────────────────────────────────────────────

export interface KnowledgeListOptions {
  category?: string;
  file?: string;
  symbol?: string;
}

export async function runKnowledgeList(
  rootDir: string,
  options: KnowledgeListOptions = {},
): Promise<void> {
  loadConfig(rootDir);

  const storage = new KnowledgeStorage(rootDir);
  let entries = storage.load();

  if (entries.length === 0) {
    console.log(
      chalk.gray(
        'No knowledge entries found. Use `ai-memory remember "<text>"` to add one.',
      ),
    );
    return;
  }

  // Filter
  if (options.category) {
    entries = entries.filter((e) => e.category === options.category);
  }
  if (options.file) {
    entries = entries.filter((e) =>
      e.relatedFiles?.some((f) => f.includes(options.file!)),
    );
  }
  if (options.symbol) {
    entries = entries.filter((e) =>
      e.relatedSymbols?.includes(options.symbol!),
    );
  }

  if (entries.length === 0) {
    console.log(chalk.gray("No entries match the given filters."));
    return;
  }

  // Group by category
  const order: KnowledgeEntry["category"][] = [
    "gotcha",
    "pattern",
    "decision",
    "glossary",
  ];
  const grouped = new Map<string, KnowledgeEntry[]>();
  for (const cat of order) grouped.set(cat, []);
  for (const e of entries) {
    grouped.get(e.category)?.push(e) ?? grouped.set(e.category, [e]);
  }

  const categoryColor: Record<string, (s: string) => string> = {
    gotcha: chalk.red,
    pattern: chalk.cyan,
    decision: chalk.yellow,
    glossary: chalk.gray,
  };

  for (const [cat, group] of grouped) {
    if (group.length === 0) continue;
    const colorFn = categoryColor[cat] ?? chalk.white;
    console.log();
    console.log(colorFn(chalk.bold(`▸ ${cat.toUpperCase()}`)));

    for (const e of group) {
      const shortId = e.id.slice(0, 8);
      const conf =
        e.confidence === "high"
          ? chalk.green("●")
          : e.confidence === "medium"
            ? chalk.yellow("●")
            : chalk.gray("●");
      console.log(
        `  ${conf} ${chalk.bold(e.title)}  ${chalk.gray(`[${shortId}]`)}`,
      );
      if (e.body !== e.title) {
        const preview =
          e.body.length > 120 ? `${e.body.slice(0, 120)}…` : e.body;
        console.log(`    ${chalk.gray(preview)}`);
      }
      if (e.relatedFiles?.length) {
        console.log(`    ${chalk.gray("files:")} ${e.relatedFiles.join(", ")}`);
      }
      if (e.relatedSymbols?.length) {
        console.log(
          `    ${chalk.gray("symbols:")} ${e.relatedSymbols.join(", ")}`,
        );
      }
      if (e.supersedes) {
        console.log(
          `    ${chalk.gray(`supersedes: ${e.supersedes.slice(0, 8)}`)}`,
        );
      }
    }
  }
  console.log();
  console.log(
    chalk.gray(
      `Total: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`,
    ),
  );
}

// ─── Forget ───────────────────────────────────────────────────────────────────

export async function runKnowledgeForget(
  rootDir: string,
  id: string,
): Promise<void> {
  loadConfig(rootDir);

  const storage = new KnowledgeStorage(rootDir);

  // Support short ID prefix (first 8 chars)
  const entries = storage.load();
  const match = entries.find((e) => e.id === id || e.id.startsWith(id));

  if (!match) {
    console.error(
      chalk.red(`Error: no entry found with ID starting with "${id}".`),
    );
    process.exit(1);
  }

  storage.remove(match.id);
  console.log(
    chalk.green(`✔ Removed entry [${match.id.slice(0, 8)}] "${match.title}".`),
  );
}

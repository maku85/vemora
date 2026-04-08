import chalk from "chalk";
import { loadConfig } from "../core/config";
import { KnowledgeStorage } from "../storage/knowledge";
import { SummaryStorage } from "../storage/summaries";

export interface BriefOptions {
  /** Include all knowledge entries, not only high-confidence ones. */
  all?: boolean;
}

/**
 * Prints a compact session primer (~L0 + L1 in mempalace terms):
 *   - Project overview (from vemora summarize)
 *   - High-confidence knowledge entries
 *
 * Designed to be run at the start of an LLM session to re-establish context
 * without loading the full index. Optimised for minimal token use.
 */
export async function runBrief(
  rootDir: string,
  options: BriefOptions = {},
): Promise<void> {
  const config = loadConfig(rootDir);
  const summaryStorage = new SummaryStorage(rootDir);
  const knowledgeStorage = new KnowledgeStorage(rootDir);

  const projectSummary = summaryStorage.loadProjectSummary();
  const allEntries = knowledgeStorage.load();
  const entries = options.all
    ? allEntries
    : allEntries.filter((e) => e.confidence === "high");

  // ── Header ───────────────────────────────────────────────────────────────────
  console.log(chalk.bold(`# ${config.projectName} — session brief`));
  console.log();

  // ── L0: Project overview ─────────────────────────────────────────────────────
  if (projectSummary) {
    console.log(chalk.bold("## Overview"));
    console.log(projectSummary.overview);
    console.log();
  } else {
    console.log(
      chalk.gray(
        "No project overview available. Run `vemora summarize` to generate one.",
      ),
    );
    console.log();
  }

  // ── L1: High-confidence knowledge ────────────────────────────────────────────
  if (entries.length > 0) {
    const label = options.all ? "Knowledge" : "Critical knowledge";
    console.log(chalk.bold(`## ${label} (${entries.length})`));
    console.log();

    const byCategory = new Map<string, typeof entries>();
    for (const e of entries) {
      const list = byCategory.get(e.category) ?? [];
      list.push(e);
      byCategory.set(e.category, list);
    }

    for (const [cat, catEntries] of byCategory) {
      console.log(chalk.underline(cat));
      for (const e of catEntries) {
        console.log(`- **${e.title}**`);
        // Print body but cap at 120 chars to keep the primer tight
        const body =
          e.body.length > 120 ? e.body.slice(0, 117) + "…" : e.body;
        console.log(`  ${chalk.gray(body)}`);
      }
      console.log();
    }
  } else {
    const hint = options.all
      ? "No knowledge entries found. Use `vemora remember` to add some."
      : "No high-confidence entries found. Use `vemora knowledge list` to review all entries.";
    console.log(chalk.gray(hint));
    console.log();
  }

  // ── Footer hint ──────────────────────────────────────────────────────────────
  console.log(
    chalk.gray(
      `Tip: run \`vemora knowledge list --root .\` for the full knowledge base.`,
    ),
  );
}

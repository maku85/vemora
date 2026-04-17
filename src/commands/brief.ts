import chalk from "chalk";
import { loadConfig } from "../core/config";
import { type SkillName, getSkill } from "../skills";
import { KnowledgeStorage, filterValidAt } from "../storage/knowledge";
import { SummaryStorage } from "../storage/summaries";
import { truncateToTokenBudget } from "../utils/tokenizer";

export interface BriefOptions {
  /** Include all knowledge entries, not only high-confidence ones. */
  all?: boolean;
  /** Max tokens to include in output. Output is truncated if exceeded. */
  budget?: number;
  /**
   * Task-type skill preset: surfaces knowledge entries most relevant to the
   * skill's category boost list and prepends a focused instruction block.
   *
   * Available: debug | refactor | add-feature | security | explain | test
   */
  skill?: SkillName;
}

/**
 * Prints a compact session primer (~L0 + L1 in mempalace terms):
 *   - Project overview (from vemora summarize)
 *   - Knowledge entries (medium + high confidence)
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

  const skill = options.skill ? getSkill(options.skill) : undefined;

  const projectSummary = summaryStorage.loadProjectSummary();
  const allEntries = filterValidAt(knowledgeStorage.load());

  // When a skill is active, sort boosted categories to the top; confidence
  // filter still applies unless --all is set.
  let entries = options.all
    ? allEntries
    : allEntries.filter((e) => e.confidence !== "low");

  if (skill && skill.knowledgeCategoryBoost.length > 0) {
    const boosted = new Set(skill.knowledgeCategoryBoost);
    entries = [
      ...entries.filter((e) => boosted.has(e.category)),
      ...entries.filter((e) => !boosted.has(e.category)),
    ];
  }

  const lines: string[] = [];

  // ── Header ───────────────────────────────────────────────────────────────────
  const skillSuffix = skill ? ` [skill: ${skill.name}]` : "";
  lines.push(chalk.bold(`# ${config.projectName} — session brief${skillSuffix}`));
  lines.push("");

  // ── Skill focus note ─────────────────────────────────────────────────────────
  if (skill) {
    lines.push(skill.outputPrefix);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  // ── L0: Project overview ─────────────────────────────────────────────────────
  if (projectSummary) {
    lines.push(chalk.bold("## Overview"));
    lines.push(projectSummary.overview);
    lines.push("");
  } else {
    lines.push(
      chalk.gray(
        "No project overview available. Run `vemora summarize` to generate one.",
      ),
    );
    lines.push("");
  }

  // ── L1: Knowledge (medium + high confidence) ─────────────────────────────────
  if (entries.length > 0) {
    const label = "Knowledge";
    lines.push(chalk.bold(`## ${label} (${entries.length})`));
    lines.push("");

    const byCategory = new Map<string, typeof entries>();
    for (const e of entries) {
      const list = byCategory.get(e.category) ?? [];
      list.push(e);
      byCategory.set(e.category, list);
    }

    for (const [cat, catEntries] of byCategory) {
      lines.push(chalk.underline(cat));
      for (const e of catEntries) {
        lines.push(`- **${e.title}**`);
        // Print body but cap at 120 chars to keep the primer tight
        const body =
          e.body.length > 120 ? e.body.slice(0, 117) + "…" : e.body;
        lines.push(`  ${chalk.gray(body)}`);
      }
      lines.push("");
    }
  } else {
    const hint = options.all
      ? "No knowledge entries found. Use `vemora remember` to add some."
      : "No knowledge entries found. Use `vemora remember` to save findings, or `--all` to include low-confidence entries.";
    lines.push(chalk.gray(hint));
    lines.push("");
  }

  // ── Footer hint ──────────────────────────────────────────────────────────────
  lines.push(
    chalk.gray(
      `Tip: run \`vemora knowledge list --root .\` for the full knowledge base.`,
    ),
  );

  let output = lines.join("\n");

  if (options.budget && options.budget > 0) {
    const { text, truncated } = truncateToTokenBudget(output, options.budget);
    output = text;
    if (truncated) {
      output += `\n\n[...truncated to ${options.budget} token budget]`;
    }
  }

  console.log(output);
}

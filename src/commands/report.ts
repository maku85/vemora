import chalk from "chalk";
import { loadConfig } from "../core/config";
import type { UsageEvent } from "../storage/usage";
import { UsageStorage } from "../storage/usage";

export interface ReportOptions {
  /** Limit report to events from the last N days (default: all) */
  days?: number;
  /** Show per-query breakdown instead of aggregate summary */
  verbose?: boolean;
  /** Clear all usage data */
  clear?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pct(n: number, total: number): string {
  return total === 0 ? "  0%" : `${Math.round((n / total) * 100).toString().padStart(3)}%`;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function bar(value: number, max: number, width = 20): string {
  const filled = max === 0 ? 0 : Math.round((value / max) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Top-N word tokens from query texts, excluding stopwords. */
function topTerms(events: UsageEvent[], n = 8): Array<{ term: string; count: number }> {
  const STOP = new Set([
    "a", "an", "the", "in", "on", "at", "to", "for", "of", "and", "or",
    "how", "what", "why", "when", "where", "is", "are", "was", "does",
    "do", "with", "from", "that", "this", "it", "be", "has", "have",
  ]);
  const freq = new Map<string, number>();
  for (const e of events) {
    if (!e.query) continue;
    const terms = e.query
      .toLowerCase()
      .split(/[\s\W]+/)
      .filter((t) => t.length >= 3 && !STOP.has(t));
    for (const t of terms) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([term, count]) => ({ term, count }));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runReport(
  rootDir: string,
  options: ReportOptions = {},
): Promise<void> {
  const config = loadConfig(rootDir);
  const storage = new UsageStorage(config.projectId);

  if (options.clear) {
    storage.clear();
    console.log(chalk.green("✓") + " Usage log cleared.");
    return;
  }

  let events = storage.load();

  if (events.length === 0) {
    console.log(
      chalk.yellow("No usage data yet.") +
        " Run some queries with `ai-memory query` or `ai-memory context`.",
    );
    return;
  }

  // ── Date filter ───────────────────────────────────────────────────────────
  if (options.days && options.days > 0) {
    const cutoff = Date.now() - options.days * 24 * 60 * 60 * 1000;
    events = events.filter((e) => new Date(e.ts).getTime() >= cutoff);
    if (events.length === 0) {
      console.log(chalk.yellow(`No usage data in the last ${options.days} days.`));
      return;
    }
  }

  const total = events.length;
  const firstTs = events[0].ts.slice(0, 10);
  const lastTs = events[events.length - 1].ts.slice(0, 10);

  // ── Aggregates ────────────────────────────────────────────────────────────
  const byCommand = { query: 0, context: 0, ask: 0 };
  const bySearch: Record<string, number> = {};
  let totalTokensReturned = 0;
  let totalSavedDedup = 0;
  let totalSavedSession = 0;
  let totalSavedBudget = 0;
  let queriesWithDedup = 0;
  let queriesWithSession = 0;
  let queriesWithBudget = 0;
  let totalResults = 0;

  for (const e of events) {
    byCommand[e.command] = (byCommand[e.command] ?? 0) + 1;
    bySearch[e.searchType] = (bySearch[e.searchType] ?? 0) + 1;
    totalTokensReturned += e.tokensReturned;
    totalSavedDedup += e.tokensSavedDedup;
    totalSavedSession += e.tokensSavedSession;
    totalSavedBudget += e.tokensSavedBudget;
    if (e.tokensSavedDedup > 0) queriesWithDedup++;
    if (e.tokensSavedSession > 0) queriesWithSession++;
    if (e.tokensSavedBudget > 0) queriesWithBudget++;
    totalResults += e.resultsReturned;
  }

  const totalSaved = totalSavedDedup + totalSavedSession + totalSavedBudget;
  const totalWouldHaveSent = totalTokensReturned + totalSaved;
  const savingsPct = totalWouldHaveSent === 0 ? 0 : Math.round((totalSaved / totalWouldHaveSent) * 100);
  const avgTokens = Math.round(totalTokensReturned / total);
  const avgResults = (totalResults / total).toFixed(1);

  // ── Header ────────────────────────────────────────────────────────────────
  console.log();
  console.log(chalk.bold("ai-memory usage report"));
  if (options.days) {
    console.log(chalk.gray(`  Last ${options.days} days · ${total} queries`));
  } else {
    console.log(chalk.gray(`  ${firstTs} → ${lastTs} · ${total} queries`));
  }
  console.log();

  // ── Commands ──────────────────────────────────────────────────────────────
  console.log(chalk.bold("Commands"));
  const maxCmd = Math.max(...Object.values(byCommand));
  for (const [cmd, count] of Object.entries(byCommand)) {
    if (count === 0) continue;
    console.log(
      `  ${chalk.cyan(cmd.padEnd(9))} ${bar(count, maxCmd, 16)}  ${fmt(count).padStart(5)}  ${pct(count, total)}`,
    );
  }
  console.log();

  // ── Search method ─────────────────────────────────────────────────────────
  console.log(chalk.bold("Search method"));
  const maxSearch = Math.max(...Object.values(bySearch));
  for (const [type, count] of Object.entries(bySearch).sort((a, b) => b[1] - a[1])) {
    console.log(
      `  ${chalk.cyan(type.padEnd(9))} ${bar(count, maxSearch, 16)}  ${fmt(count).padStart(5)}  ${pct(count, total)}`,
    );
  }
  console.log();

  // ── Results & tokens ──────────────────────────────────────────────────────
  console.log(chalk.bold("Results & tokens"));
  console.log(`  Avg results returned   ${chalk.white(avgResults)} chunks per query`);
  console.log(`  Avg tokens returned    ${chalk.white(fmt(avgTokens))} tokens per query`);
  console.log(`  Total tokens served    ${chalk.white(fmt(totalTokensReturned))}`);
  console.log();

  // ── Token savings ─────────────────────────────────────────────────────────
  console.log(chalk.bold("Token savings estimate"));
  if (totalSaved === 0) {
    console.log(chalk.gray("  No savings recorded yet (dedup, session filter, and budget all inactive)."));
  } else {
    const row = (label: string, saved: number, queries: number) => {
      const avg = queries === 0 ? 0 : Math.round(saved / queries);
      console.log(
        `  ${label.padEnd(22)} ${chalk.green(fmt(saved).padStart(8))} tokens` +
          (queries > 0
            ? chalk.gray(`  (${queries} queries, ~${fmt(avg)}/query)`)
            : ""),
      );
    };
    row("Semantic dedup", totalSavedDedup, queriesWithDedup);
    row("Session filter", totalSavedSession, queriesWithSession);
    row("Budget cap", totalSavedBudget, queriesWithBudget);
    console.log(
      "  " + "─".repeat(50),
    );
    console.log(
      `  ${"Total saved".padEnd(22)} ${chalk.bold.green(fmt(totalSaved).padStart(8))} tokens  ` +
        chalk.gray(`(${savingsPct}% of what would have been sent)`),
    );
  }
  console.log();

  // ── Top query terms ───────────────────────────────────────────────────────
  const terms = topTerms(events);
  if (terms.length > 0) {
    console.log(chalk.bold("Most frequent query terms"));
    const maxTermCount = terms[0].count;
    for (const { term, count } of terms) {
      console.log(
        `  ${chalk.cyan(term.padEnd(20))} ${bar(count, maxTermCount, 16)}  ${count}×`,
      );
    }
    console.log();
  }

  // ── Verbose: per-query log ─────────────────────────────────────────────────
  if (options.verbose) {
    console.log(chalk.bold("Recent queries (last 20)"));
    console.log();
    const recent = events.slice(-20).reverse();
    for (const e of recent) {
      const saved = e.tokensSavedDedup + e.tokensSavedSession + e.tokensSavedBudget;
      const savedStr = saved > 0 ? chalk.green(` −${fmt(saved)}tok`) : "";
      console.log(
        `  ${chalk.gray(e.ts.slice(0, 16))}  ${chalk.cyan(e.command.padEnd(8))}  ` +
          `${chalk.white(fmt(e.tokensReturned).padStart(5))}tok${savedStr}  ` +
          chalk.gray(e.query ?? "(no query)"),
      );
    }
    console.log();
  }
}

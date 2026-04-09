#!/usr/bin/env node

/**
 * vemora CLI
 *
 * Repository-local memory system for LLM-assisted development.
 * Builds a structured, versioned index of a codebase and enables
 * semantic search over it using local or remote embedding providers.
 *
 * Usage:
 *   vemora init              Initialize .vemora/ in the current repo
 *   vemora index             Scan and index the repository (incremental)
 *   vemora query "<text>"    Find relevant code chunks
 *   vemora status            Show current index stats
 */

import chalk from "chalk";
import { Command } from "commander";
import path from "path";
import { runAsk } from "./commands/ask";
import { runBrief } from "./commands/brief";
import { runAudit } from "./commands/audit";
import { runFocus } from "./commands/focus";
import { runPlan } from "./commands/plan";
import { runTriage } from "./commands/triage";
import { runDeadCode } from "./commands/dead-code";
import { runChat } from "./commands/chat";
import { runContext } from "./commands/context";
import { runDeps } from "./commands/deps";
import { runIndex } from "./commands/index";
import { runInit } from "./commands/init";
import { runInitAgent } from "./commands/init-agent";
import { runKnowledgeForget, runKnowledgeList } from "./commands/knowledge";
import { runQuery } from "./commands/query";
import { runRemember } from "./commands/remember";
import { runUsages } from "./commands/usages";
import { runReport } from "./commands/report";
import { runStatus } from "./commands/status";
import { runSummarize } from "./commands/summarize";

const program = new Command();

program
  .name("vemora")
  .description("Repository-local memory system for LLM-assisted development")
  .version(require("../package.json").version);

// ── init ──────────────────────────────────────────────────────────────────────

program
  .command("init")
  .description("Initialize vemora in the current repository")
  .option("--root <dir>", "project root directory (default: cwd)", "")
  .action(async (opts: { root: string }) => {
    const rootDir = path.resolve(opts.root || process.cwd());
    try {
      await runInit(rootDir);
    } catch (err) {
      console.error(chalk.red("Error:"), (err as Error).message);
      process.exit(1);
    }
  });

// ── index ─────────────────────────────────────────────────────────────────────

program
  .command("index")
  .description("Index the repository content")
  .option("--root <dir>", "Project root directory", process.cwd())
  .option("--force", "Re-index all files, ignoring hashes", false)
  .option("--no-embed", "Skip embedding generation", false)
  .option("-w, --watch", "Watch for changes and re-index automatically", false)
  .action(
    async (opts: {
      root: string;
      force: boolean;
      embed: boolean;
      watch: boolean;
    }) => {
      const rootDir = path.resolve(opts.root || process.cwd());
      try {
        // Commander's --no-embed sets opts.embed = false
        await runIndex(rootDir, {
          force: opts.force,
          noEmbed: !opts.embed,
          watch: opts.watch,
        });
      } catch (err) {
        console.error(chalk.red("Error:"), (err as Error).message);
        process.exit(1);
      }
    },
  );

// ── query ─────────────────────────────────────────────────────────────────────

program
  .command("query <question>")
  .description("Search the vemora index for relevant code")
  .option("--root <dir>", "project root directory (default: cwd)", "")
  .option("-k, --top-k <n>", "number of results to return", "10")
  .option("-c, --show-code", "print code snippets in results", false)
  .option("--keyword", "use keyword search instead of semantic search", false)
  .option(
    "--format <fmt>",
    "output format: terminal (default), json, markdown",
    "terminal",
  )
  .option(
    "--rerank",
    "re-score results with a cross-encoder model (slower but more accurate)",
    false,
  )
  .option("--hybrid", "use hybrid search (vector + BM25)", false)
  .option(
    "--alpha <n>",
    "hybrid weight for vector search (0-1, default: 0.7)",
    "0.7",
  )
  .option(
    "--budget <n>",
    "max tokens to include across results (overrides top-k as upper bound)",
  )
  .option(
    "--mmr",
    "apply Maximal Marginal Relevance to diversify results",
    false,
  )
  .option(
    "--lambda <n>",
    "MMR relevance weight (0=diverse, 1=relevant, default: 0.5)",
    "0.5",
  )
  .option(
    "--merge",
    "merge adjacent or overlapping chunks from the same file",
    false,
  )
  .option(
    "--merge-gap <n>",
    "max line gap between chunks to still merge (default: 3)",
    "3",
  )
  .option(
    "--session",
    "skip chunks already seen in this session (auto-expires after 30 min idle)",
    false,
  )
  .option("--fresh", "reset session memory before this query", false)
  .action(
    async (
      question: string,
      opts: {
        root: string;
        topK: string;
        showCode: boolean;
        keyword: boolean;
        format: string;
        rerank: boolean;
        hybrid: boolean;
        alpha: string;
        budget?: string;
        mmr: boolean;
        lambda: string;
        merge: boolean;
        mergeGap: string;
        session: boolean;
        fresh: boolean;
      },
    ) => {
      const rootDir = path.resolve(opts.root || process.cwd());
      const fmt = opts.format as "terminal" | "json" | "markdown";
      if (!["terminal", "json", "markdown"].includes(fmt)) {
        console.error(
          chalk.red(`Unknown format "${fmt}". Use: terminal, json, markdown`),
        );
        process.exit(1);
      }
      try {
        await runQuery(rootDir, question, {
          topK: parseInt(opts.topK, 10),
          showCode: opts.showCode,
          keyword: opts.keyword,
          format: fmt,
          rerank: opts.rerank,
          hybrid: opts.hybrid,
          alpha: parseFloat(opts.alpha),
          budget: opts.budget ? parseInt(opts.budget, 10) : undefined,
          mmr: opts.mmr,
          lambda: parseFloat(opts.lambda),
          merge: opts.merge,
          mergeGap: parseInt(opts.mergeGap, 10),
          session: opts.session,
          fresh: opts.fresh,
        });
      } catch (err) {
        console.error(chalk.red("Error:"), (err as Error).message);
        process.exit(1);
      }
    },
  );

// ── status ────────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show current index stats")
  .option("--root <dir>", "project root directory (default: cwd)", "")
  .action(async (opts: { root: string }) => {
    const rootDir = path.resolve(opts.root || process.cwd());
    try {
      await runStatus(rootDir);
    } catch (err) {
      console.error(chalk.red("Error:"), (err as Error).message);
      process.exit(1);
    }
  });

// ── ask ───────────────────────────────────────────────────────────────────────

program
  .command("ask <question>")
  .description(
    "One-shot Q&A: retrieve relevant context and answer with the configured LLM",
  )
  .option("--root <dir>", "project root directory (default: cwd)", "")
  .option("-k, --top-k <n>", "number of chunks to retrieve", "5")
  .option("--keyword", "use keyword search (no embeddings required)", false)
  .option("--hybrid", "use hybrid vector+BM25 search", false)
  .option(
    "--budget <n>",
    "max context tokens to send to the LLM (default: 6000)",
    "6000",
  )
  .option("--show-context", "print the retrieved context before the answer", false)
  .action(
    async (
      question: string,
      opts: {
        root: string;
        topK: string;
        keyword: boolean;
        hybrid: boolean;
        budget: string;
        showContext: boolean;
      },
    ) => {
      const rootDir = path.resolve(opts.root || process.cwd());
      try {
        await runAsk(rootDir, question, {
          topK: Number.parseInt(opts.topK, 10),
          keyword: opts.keyword,
          hybrid: opts.hybrid,
          budget: Number.parseInt(opts.budget, 10),
          showContext: opts.showContext,
        });
      } catch (err) {
        console.error(chalk.red("Error:"), (err as Error).message);
        process.exit(1);
      }
    },
  );

// ── plan ──────────────────────────────────────────────────────────────────────

program
  .command("plan <task>")
  .description(
    "Planner-executor: a pro LLM decomposes the task, a smaller LLM executes each step",
  )
  .option("--root <dir>", "project root directory (default: cwd)", "")
  .option("-k, --top-k <n>", "chunks to retrieve per step (default: 5)", "5")
  .option("--keyword", "use keyword search (no embeddings required)", false)
  .option(
    "--budget <n>",
    "max context tokens per step (default: 4000)",
    "4000",
  )
  .option("--show-context", "print retrieved context for each step", false)
  .option(
    "--confirm",
    "show the plan and ask for confirmation before executing",
    false,
  )
  .option(
    "--synthesize",
    "call the planner again after all steps to produce a single final answer",
    false,
  )
  .action(
    async (
      task: string,
      opts: {
        root: string;
        topK: string;
        keyword: boolean;
        budget: string;
        showContext: boolean;
        confirm: boolean;
        synthesize: boolean;
      },
    ) => {
      const rootDir = path.resolve(opts.root || process.cwd());
      try {
        await runPlan(rootDir, task, {
          topK: Number.parseInt(opts.topK, 10),
          keyword: opts.keyword,
          budget: Number.parseInt(opts.budget, 10),
          showContext: opts.showContext,
          confirm: opts.confirm,
          synthesize: opts.synthesize,
        });
      } catch (err) {
        console.error(chalk.red("Error:"), (err as Error).message);
        process.exit(1);
      }
    },
  );

// ── chat ──────────────────────────────────────────────────────────────────────

program
  .command("chat")
  .description("Interactive chat with the codebase (middleware proxy)")
  .option("--root <dir>", "project root directory (default: cwd)", "")
  .option("--provider <name>", "LLM provider (openai, anthropic, ollama)")
  .option("--model <name>", "LLM model to use")
  .option(
    "-k, --top-k <n>",
    "number of context chunks to pull per message (default: 5)",
    "5",
  )
  .action(
    async (opts: {
      root: string;
      provider?: string;
      model?: string;
      topK: string;
    }) => {
      const rootDir = path.resolve(opts.root || process.cwd());
      try {
        await runChat(rootDir, {
          provider: opts.provider,
          model: opts.model,
          topK: parseInt(opts.topK, 10),
        });
      } catch (err) {
        console.error(chalk.red("Error:"), (err as Error).message);
        process.exit(1);
      }
    },
  );

// ── context ──────────────────────────────────────────────────────────────────

program
  .command("context")
  .description("Generate an optimized LLM context block from query and/or file")
  .option("--root <dir>", "project root directory (default: cwd)", "")
  .option("-q, --query <text>", "natural-language query to find relevant code")
  .option(
    "-f, --file <path>",
    "include a specific file in full with its dependency graph",
  )
  .option(
    "-k, --top-k <n>",
    "number of search results to include (default: 5)",
    "5",
  )
  .option("--keyword", "use keyword search instead of semantic search", false)
  .option("--show-code", "show full code (no line cap)", false)
  .option(
    "--format <fmt>",
    "output format: markdown (default), plain, terse",
  )
  .option("--rerank", "re-score results with a cross-encoder model", false)
  .option("--hybrid", "use hybrid search (vector + BM25)", false)
  .option(
    "--alpha <n>",
    "hybrid weight for vector search (0-1, default: 0.7)",
    "0.7",
  )
  .option("--budget <n>", "max tokens to include across retrieved chunks")
  .option(
    "--mmr",
    "apply Maximal Marginal Relevance to diversify results",
    false,
  )
  .option(
    "--lambda <n>",
    "MMR relevance weight (0=diverse, 1=relevant, default: 0.5)",
    "0.5",
  )
  .option(
    "--merge",
    "merge adjacent or overlapping chunks from the same file",
    false,
  )
  .option(
    "--merge-gap <n>",
    "max line gap between chunks to still merge (default: 3)",
    "3",
  )
  .option(
    "--structured",
    "emit a structured context block (Entry Point / Dependencies / Types / Related Patterns)",
    false,
  )
  .option(
    "--session",
    "skip chunks already seen in this session (auto-expires after 30 min idle)",
    false,
  )
  .option("--fresh", "reset session memory before this query", false)
  .action(
    async (opts: {
      root: string;
      query?: string;
      file?: string;
      topK: string;
      keyword: boolean;
      showCode: boolean;
      format?: string;
      rerank: boolean;
      hybrid: boolean;
      alpha: string;
      budget?: string;
      mmr: boolean;
      lambda: string;
      merge: boolean;
      mergeGap: string;
      structured: boolean;
      session: boolean;
      fresh: boolean;
    }) => {
      const rootDir = path.resolve(opts.root || process.cwd());
      const fmt = opts.format as "markdown" | "plain" | "terse" | undefined;
      if (fmt && !["markdown", "plain", "terse"].includes(fmt)) {
        console.error(
          chalk.red(`Unknown format "${fmt}". Use: markdown, plain, terse`),
        );
        process.exit(1);
      }
      try {
        await runContext(rootDir, {
          query: opts.query,
          file: opts.file,
          topK: parseInt(opts.topK, 10),
          keyword: opts.keyword,
          showCode: opts.showCode,
          format: fmt,
          rerank: opts.rerank,
          hybrid: opts.hybrid,
          alpha: parseFloat(opts.alpha),
          budget: opts.budget ? parseInt(opts.budget, 10) : undefined,
          mmr: opts.mmr,
          lambda: parseFloat(opts.lambda),
          merge: opts.merge,
          mergeGap: parseInt(opts.mergeGap, 10),
          structured: opts.structured,
          session: opts.session,
          fresh: opts.fresh,
        });
      } catch (err) {
        console.error(chalk.red("Error:"), (err as Error).message);
        process.exit(1);
      }
    },
  );

// ── deps ──────────────────────────────────────────────────────────────────────

program
  .command("deps <file>")
  .description("Show dependency context for a file (imports + used-by)")
  .option("--root <dir>", "project root directory (default: cwd)", "")
  .option(
    "-d, --depth <n>",
    "transitive depth for outgoing imports (default: 1)",
    "1",
  )
  .option(
    "-r, --reverse-depth <n>",
    "transitive depth for incoming importers (default: 1)",
    "1",
  )
  .action(async (file: string, opts: { root: string; depth: string; reverseDepth: string }) => {
    const rootDir = path.resolve(opts.root || process.cwd());
    try {
      await runDeps(rootDir, file, {
        depth: parseInt(opts.depth, 10),
        reverseDepth: parseInt(opts.reverseDepth, 10),
      });
    } catch (err) {
      console.error(chalk.red("Error:"), (err as Error).message);
      process.exit(1);
    }
  });

// ── summarize ─────────────────────────────────────────────────────────────────

program
  .command("summarize")
  .description("Generate LLM summaries for each file and a project overview")
  .option("--root <dir>", "project root directory (default: cwd)", "")
  .option(
    "--force",
    "re-generate all summaries, ignoring content hashes",
    false,
  )
  .option("--model <name>", "override LLM model (default: from config)")
  .option(
    "--files-only",
    "only generate per-file summaries, skip project overview",
    false,
  )
  .option(
    "--project-only",
    "(re)generate project overview from existing file summaries",
    false,
  )
  .option("--show", "print the existing project overview without regenerating", false)
  .action(
    async (opts: {
      root: string;
      force: boolean;
      model?: string;
      filesOnly: boolean;
      projectOnly: boolean;
      show: boolean;
    }) => {
      const rootDir = path.resolve(opts.root || process.cwd());
      try {
        await runSummarize(rootDir, {
          force: opts.force,
          model: opts.model,
          filesOnly: opts.filesOnly,
          projectOnly: opts.projectOnly,
          show: opts.show,
        });
      } catch (err) {
        console.error(chalk.red("Error:"), (err as Error).message);
        process.exit(1);
      }
    },
  );

// ── init-agent ────────────────────────────────────────────────────────────────

program
  .command("init-agent")
  .description(
    "Generate AI agent instruction files (CLAUDE.md, GEMINI.md, .github/copilot-instructions.md, .cursor/rules/vemora.mdc, .windsurfrules)",
  )
  .option(
    "--agent <agent>",
    "Which agent to target: claude, gemini, copilot, cursor, windsurf (default: all)",
  )
  .option("--force", "Overwrite existing files that have no vemora markers")
  .option(
    "--hooks",
    "Write Claude Code hooks to .claude/settings.json (claude target only)",
    false,
  )
  .option("--root <dir>", "Project root directory", process.cwd())
  .action(async (opts: { agent?: string; force?: boolean; hooks: boolean; root: string }) => {
    const ALL_AGENTS = ["claude", "copilot", "cursor", "windsurf", "gemini"] as const;
    type AgentTarget = (typeof ALL_AGENTS)[number];
    const agents: AgentTarget[] | undefined = opts.agent
      ? ALL_AGENTS.includes(opts.agent as AgentTarget)
        ? [opts.agent as AgentTarget]
        : undefined
      : undefined;
    if (opts.agent && !agents) {
      console.error(
        chalk.red(
          `Unknown agent "${opts.agent}". Valid values: claude, gemini, copilot, cursor, windsurf`,
        ),
      );
      process.exit(1);
    }
    try {
      await runInitAgent(opts.root, { agents, force: opts.force, hooks: opts.hooks });
    } catch (err) {
      console.error(chalk.red("Error:"), (err as Error).message);
      process.exit(1);
    }
  });

// ── remember ──────────────────────────────────────────────────────────────────

program
  .command("remember <text>")
  .description(
    "Save a knowledge entry (architectural decision, pattern, gotcha, glossary term)",
  )
  .option("--root <dir>", "project root directory (default: cwd)", "")
  .option(
    "--category <cat>",
    "entry category: decision | pattern | gotcha | glossary (auto-classified if omitted)",
  )
  .option("--title <title>", "short title (auto-derived from text if omitted)")
  .option(
    "--files <paths>",
    "comma-separated project-relative file paths this entry relates to",
  )
  .option(
    "--symbols <names>",
    "comma-separated symbol names this entry relates to",
  )
  .option(
    "--confidence <level>",
    "confidence level: high | medium | low",
    "medium",
  )
  .option("--supersedes <id>", "ID of an existing entry this replaces")
  .option("--by <author>", "createdBy tag (default: human)", "human")
  .action(
    async (
      text: string,
      opts: {
        root: string;
        category: string;
        title?: string;
        files?: string;
        symbols?: string;
        confidence: string;
        supersedes?: string;
        by: string;
      },
    ) => {
      const rootDir = path.resolve(opts.root || process.cwd());
      try {
        await runRemember(rootDir, text, {
          category: opts.category as
            | "decision"
            | "pattern"
            | "gotcha"
            | "glossary"
            | undefined,
          title: opts.title,
          files: opts.files,
          symbols: opts.symbols,
          confidence: opts.confidence as "high" | "medium" | "low",
          supersedes: opts.supersedes,
          createdBy: opts.by,
        });
      } catch (err) {
        console.error(chalk.red("Error:"), (err as Error).message);
        process.exit(1);
      }
    },
  );

// ── knowledge ─────────────────────────────────────────────────────────────────

const knowledge = program
  .command("knowledge")
  .description("Manage the project knowledge store");

knowledge
  .command("list")
  .description("List knowledge entries, optionally filtered")
  .option("--root <dir>", "project root directory (default: cwd)", "")
  .option(
    "--category <cat>",
    "filter by category: decision | pattern | gotcha | glossary",
  )
  .option("--file <path>", "filter by related file path (substring match)")
  .option("--symbol <name>", "filter by related symbol name")
  .option("--as-of <date>", "show only entries valid at this ISO date")
  .option("--expired", "show only entries that have been invalidated", false)
  .action(
    async (opts: {
      root: string;
      category?: string;
      file?: string;
      symbol?: string;
      asOf?: string;
      expired: boolean;
    }) => {
      const rootDir = path.resolve(opts.root || process.cwd());
      try {
        await runKnowledgeList(rootDir, {
          category: opts.category,
          file: opts.file,
          symbol: opts.symbol,
          asOf: opts.asOf,
          expired: opts.expired,
        });
      } catch (err) {
        console.error(chalk.red("Error:"), (err as Error).message);
        process.exit(1);
      }
    },
  );

knowledge
  .command("forget <id>")
  .description("Remove a knowledge entry by ID (prefix match supported)")
  .option("--root <dir>", "project root directory (default: cwd)", "")
  .option("--invalidate", "mark as expired instead of deleting (preserves history)", false)
  .action(async (id: string, opts: { root: string; invalidate: boolean }) => {
    const rootDir = path.resolve(opts.root || process.cwd());
    try {
      await runKnowledgeForget(rootDir, id, { invalidate: opts.invalidate });
    } catch (err) {
      console.error(chalk.red("Error:"), (err as Error).message);
      process.exit(1);
    }
  });

// ── usages ────────────────────────────────────────────────────────────────────

program
  .command("usages <symbol>")
  .description(
    "Find all files that use a symbol, following re-export chains",
  )
  .option("--root <dir>", "project root directory (default: cwd)", "")
  .option(
    "-d, --depth <n>",
    "max re-export chain depth to follow (default: 10)",
    "10",
  )
  .option(
    "--callers-only",
    "show only files with call graph data (known call sites)",
    false,
  )
  .action(
    async (
      symbol: string,
      opts: { root: string; depth: string; callersOnly: boolean },
    ) => {
      const rootDir = path.resolve(opts.root || process.cwd());
      try {
        await runUsages(rootDir, symbol, {
          depth: parseInt(opts.depth, 10),
          callersOnly: opts.callersOnly,
        });
      } catch (err) {
        console.error(chalk.red("Error:"), (err as Error).message);
        process.exit(1);
      }
    },
  );

// ── report ────────────────────────────────────────────────────────────────────

program
  .command("report")
  .description("Show usage statistics: token savings, query latency, hot files, and low-signal queries")
  .option("--root <dir>", "project root directory (default: cwd)", "")
  .option("--days <n>", "limit report to events from the last N days")
  .option("-v, --verbose", "show per-query breakdown (last 20 queries)", false)
  .option("--clear", "clear all recorded usage data", false)
  .action(
    async (opts: { root: string; days?: string; verbose: boolean; clear: boolean }) => {
      const rootDir = path.resolve(opts.root || process.cwd());
      try {
        await runReport(rootDir, {
          days: opts.days ? parseInt(opts.days, 10) : undefined,
          verbose: opts.verbose,
          clear: opts.clear,
        });
      } catch (err) {
        console.error(chalk.red("Error:"), (err as Error).message);
        process.exit(1);
      }
    },
  );

// ── audit ─────────────────────────────────────────────────────────────────────

program
  .command("audit")
  .description(
    "Systematic code audit for security vulnerabilities, performance issues, and bugs",
  )
  .option("--root <dir>", "project root directory (default: cwd)", "")
  .option(
    "--type <types>",
    "comma-separated audit types: security, performance, bugs (default: all)",
  )
  .option(
    "--since <ref>",
    "only audit files changed since this git ref (e.g. HEAD~5, main)",
  )
  .option(
    "--budget <n>",
    "max context tokens per step (default: 5000)",
    "5000",
  )
  .option("--keyword", "use keyword search (no embeddings required)", false)
  .option(
    "--output <fmt>",
    "output format: terminal (default), json, markdown",
    "terminal",
  )
  .option(
    "--save",
    "save critical/high findings as knowledge entries",
    false,
  )
  .action(
    async (opts: {
      root: string;
      type?: string;
      since?: string;
      budget: string;
      keyword: boolean;
      output: string;
      save: boolean;
    }) => {
      const rootDir = path.resolve(opts.root || process.cwd());

      const validTypes = ["security", "performance", "bugs"] as const;
      type AuditType = (typeof validTypes)[number];

      let types: AuditType[] | undefined;
      if (opts.type) {
        const requested = opts.type.split(",").map((t) => t.trim()) as AuditType[];
        const invalid = requested.filter((t) => !validTypes.includes(t));
        if (invalid.length > 0) {
          console.error(
            chalk.red(
              `Unknown audit type(s): ${invalid.join(", ")}. Valid: security, performance, bugs`,
            ),
          );
          process.exit(1);
        }
        types = requested;
      }

      const outputFmt = opts.output as "terminal" | "json" | "markdown";
      if (!["terminal", "json", "markdown"].includes(outputFmt)) {
        console.error(
          chalk.red(`Unknown output format "${opts.output}". Use: terminal, json, markdown`),
        );
        process.exit(1);
      }

      try {
        await runAudit(rootDir, {
          types,
          since: opts.since,
          budget: Number.parseInt(opts.budget, 10),
          keyword: opts.keyword,
          output: outputFmt,
          save: opts.save,
        });
      } catch (err) {
        console.error(chalk.red("Error:"), (err as Error).message);
        process.exit(1);
      }
    },
  );

// ── triage ────────────────────────────────────────────────────────────────────

program
  .command("triage")
  .description(
    "Static heuristic scan for bugs, security issues, and performance problems — no LLM required",
  )
  .option("--root <dir>", "project root directory (default: cwd)", "")
  .option(
    "--type <types>",
    "comma-separated types: bugs, security, performance (default: all)",
  )
  .option(
    "-k, --top-k <n>",
    "max findings to return, ranked by score (default: 30)",
    "30",
  )
  .option(
    "--min-score <n>",
    "skip findings below this score threshold (default: 1)",
    "1",
  )
  .option("--file <path>", "restrict scan to files matching this substring")
  .option(
    "--output <fmt>",
    "output format: terminal (default), json, markdown",
    "terminal",
  )
  .action(
    async (opts: {
      root: string;
      type?: string;
      topK: string;
      minScore: string;
      file?: string;
      output: string;
    }) => {
      const rootDir = path.resolve(opts.root || process.cwd());

      const validTypes = ["bugs", "security", "performance"] as const;
      type TriageType = (typeof validTypes)[number];

      let types: TriageType[] | undefined;
      if (opts.type) {
        const requested = opts.type.split(",").map((t) => t.trim()) as TriageType[];
        const invalid = requested.filter((t) => !validTypes.includes(t));
        if (invalid.length > 0) {
          console.error(
            chalk.red(
              `Unknown type(s): ${invalid.join(", ")}. Valid: bugs, security, performance`,
            ),
          );
          process.exit(1);
        }
        types = requested;
      }

      const outputFmt = opts.output as "terminal" | "json" | "markdown";
      if (!["terminal", "json", "markdown"].includes(outputFmt)) {
        console.error(
          chalk.red(`Unknown output format "${opts.output}". Use: terminal, json, markdown`),
        );
        process.exit(1);
      }

      try {
        await runTriage(rootDir, {
          types,
          topK: Number.parseInt(opts.topK, 10),
          minScore: Number.parseInt(opts.minScore, 10),
          file: opts.file,
          output: outputFmt,
        });
      } catch (err) {
        console.error(chalk.red("Error:"), (err as Error).message);
        process.exit(1);
      }
    },
  );

// ── dead-code ─────────────────────────────────────────────────────────────────

program
  .command("dead-code")
  .description(
    "Detect unused private symbols, exports nobody imports, and unreachable files — no LLM required",
  )
  .option("--root <dir>", "project root directory (default: cwd)", "")
  .option(
    "--type <types>",
    "comma-separated types: uncalled-private, unused-export, unreachable-file (default: all)",
  )
  .option(
    "--output <fmt>",
    "output format: terminal (default), json",
    "terminal",
  )
  .action(
    async (opts: { root: string; type?: string; output: string }) => {
      const rootDir = path.resolve(opts.root || process.cwd());

      const validTypes = ["uncalled-private", "unused-export", "unreachable-file"] as const;
      type DeadCodeType = (typeof validTypes)[number];

      let types: DeadCodeType[] | undefined;
      if (opts.type) {
        const requested = opts.type.split(",").map((t) => t.trim()) as DeadCodeType[];
        const invalid = requested.filter((t) => !validTypes.includes(t));
        if (invalid.length > 0) {
          console.error(
            chalk.red(
              `Unknown type(s): ${invalid.join(", ")}. Valid: uncalled-private, unused-export, unreachable-file`,
            ),
          );
          process.exit(1);
        }
        types = requested;
      }

      const outputFmt = opts.output as "terminal" | "json";
      if (!["terminal", "json"].includes(outputFmt)) {
        console.error(chalk.red(`Unknown output format "${opts.output}". Use: terminal, json`));
        process.exit(1);
      }

      try {
        await runDeadCode(rootDir, { types, output: outputFmt });
      } catch (err) {
        console.error(chalk.red("Error:"), (err as Error).message);
        process.exit(1);
      }
    },
  );

// ── focus ─────────────────────────────────────────────────────────────────────

program
  .command("focus <target>")
  .description(
    "Show implementation, dependencies, callers, tests and knowledge for a file or symbol",
  )
  .option("--root <dir>", "project root directory (default: cwd)", "")
  .option(
    "--format <fmt>",
    "output format: markdown (default), plain",
    "markdown",
  )
  .option("--budget <n>", "max tokens to include in output")
  .action(
    async (target: string, opts: { root: string; format: string; budget?: string }) => {
      const rootDir = path.resolve(opts.root || process.cwd());
      const fmt = opts.format as "markdown" | "plain";
      if (!["markdown", "plain"].includes(fmt)) {
        console.error(chalk.red(`Unknown format "${fmt}". Use: markdown, plain`));
        process.exit(1);
      }
      try {
        await runFocus(rootDir, target, {
          format: fmt,
          budget: opts.budget ? parseInt(opts.budget, 10) : undefined,
        });
      } catch (err) {
        console.error(chalk.red("Error:"), (err as Error).message);
        process.exit(1);
      }
    },
  );

// ── brief ─────────────────────────────────────────────────────────────────────

program
  .command("brief")
  .description(
    "Print a compact session primer: project overview + high-confidence knowledge",
  )
  .option("--root <dir>", "project root directory (default: cwd)", "")
  .option("--all", "include all knowledge entries, not only high-confidence ones", false)
  .option("--budget <n>", "max tokens to include in output")
  .action(async (opts: { root: string; all: boolean; budget?: string }) => {
    const rootDir = path.resolve(opts.root || process.cwd());
    try {
      await runBrief(rootDir, {
        all: opts.all,
        budget: opts.budget ? parseInt(opts.budget, 10) : undefined,
      });
    } catch (err) {
      console.error(chalk.red("Error:"), (err as Error).message);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────────────────────

program.parse(process.argv);

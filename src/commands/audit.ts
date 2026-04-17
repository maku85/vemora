import chalk from "chalk";
import ora from "ora";
import { loadConfig } from "../core/config";
import type {
  CallGraph,
  Chunk,
  DependencyGraph,
  FileSummaryIndex,
  KnowledgeEntry,
  SearchResult,
  SummarizationConfig,
  SymbolIndex,
} from "../core/types";
import { createLLMProvider } from "../llm/factory";
import { computeBM25Scores } from "../search/bm25";
import { EmbeddingCacheStorage } from "../storage/cache";
import { KnowledgeStorage } from "../storage/knowledge";
import { RepositoryStorage } from "../storage/repository";
import { SummaryStorage } from "../storage/summaries";
import { applyTokenBudget } from "../utils/tokenizer";
import { getChangedFiles } from "../utils/git";
import { generateContextString } from "./context";

// ─── Public types ─────────────────────────────────────────────────────────────

export type AuditType = "security" | "performance" | "bugs";

export interface AuditOptions {
  /** Audit types to run (default: all three) */
  types?: AuditType[];
  /** Only audit files changed since this git ref (e.g. HEAD~5, main) */
  since?: string;
  /** Max context tokens per step (default: 5000) */
  budget?: number;
  /** Force keyword search */
  keyword?: boolean;
  /** Output format */
  output?: "terminal" | "json" | "markdown";
  /** Save critical/high findings as knowledge entries */
  save?: boolean;
}

// ─── Internal types ───────────────────────────────────────────────────────────

type Severity = "critical" | "high" | "medium" | "low" | "info";

interface AuditFinding {
  severity: Severity;
  category: string;
  file: string;
  line?: number;
  description: string;
  recommendation: string;
}

interface AuditStep {
  id: number;
  files: string[];
  description: string;
}

// ─── Checklists ───────────────────────────────────────────────────────────────

const CHECKLISTS: Record<AuditType, string[]> = {
  security: [
    "SQL/NoSQL injection: user input concatenated into queries without parameterization",
    "Command injection: user input passed to exec/spawn/eval",
    "Path traversal: user input used in file paths without normalization",
    "XSS: unescaped user input rendered as HTML",
    "Hardcoded secrets: API keys, passwords, tokens, private keys in source",
    "Weak cryptography: MD5, SHA1, DES, ECB mode, hardcoded IV/salt",
    "Missing authentication: endpoints or functions that should verify identity but don't",
    "Missing authorization: auth checks that don't verify permissions/roles",
    "Insecure deserialization: eval() or JSON.parse() on untrusted external input",
    "Sensitive data in logs: passwords, tokens, PII written to logs",
    "Open redirects: user-controlled URLs used in redirects without allowlist",
    "CSRF: state-changing operations (POST/PUT/DELETE) without CSRF protection",
    "Insecure direct object reference: IDs used to fetch resources without ownership check",
    "Prototype pollution: merging user objects without sanitization",
  ],
  performance: [
    "N+1 queries: database or API calls inside loops",
    "Missing await: async functions called without await, especially inside loops",
    "Synchronous I/O: readFileSync/writeFileSync in request handlers or hot paths",
    "Unbounded data loading: fetching all records without pagination or limits",
    "Memory accumulation: arrays, maps, or caches that grow without eviction",
    "Redundant computation: expensive operations (regex, sort, parse) repeated unnecessarily",
    "Blocking event loop: CPU-intensive synchronous code in async context",
    "Unnecessary serialization: JSON.stringify/parse in tight loops",
    "Missing memoization: pure functions called repeatedly with same args",
    "Large object copies: unnecessary deep clones or full object spreads",
    "Unindexed lookups: linear search (Array.find, filter) over large collections that could use a Map",
    "Repeated DOM/tree traversal in loops (if applicable)",
  ],
  bugs: [
    "Null/undefined dereference: accessing properties without null checks",
    "Unhandled promise rejections: .then() without .catch(), missing try/catch around await",
    "Missing error handling: no error path in critical operations (network, disk, parse)",
    "Off-by-one: array indexing with length instead of length-1, loop bounds",
    "Race conditions: shared mutable state accessed across concurrent async operations",
    "Type coercion: == instead of ===, implicit conversions causing unexpected behavior",
    "Infinite loops: while/for loops missing a guaranteed exit condition",
    "Resource leaks: file handles, sockets, DB connections not closed in error paths",
    "Dead code: unreachable branches, unused variables that suggest logic errors",
    "Incorrect error propagation: errors swallowed in catch blocks (empty catch, console.log only)",
    "Mutating function arguments: modifying caller's objects unexpectedly",
    "Integer overflow / float precision: arithmetic on large numbers without guards",
  ],
};

// ─── Prompts ──────────────────────────────────────────────────────────────────

function buildAuditPlannerPrompt(
  types: AuditType[],
  fileCount: number,
): string {
  const checklistSections = types
    .map((t) => `### ${t.toUpperCase()}\n${CHECKLISTS[t].map((c) => `- ${c}`).join("\n")}`)
    .join("\n\n");

  return (
    `You are an expert code auditor.\n` +
    `Create a systematic audit plan covering ALL ${fileCount} listed files.\n\n` +
    `Audit focus:\n${checklistSections}\n\n` +
    `Rules:\n` +
    `- Group 2-5 related files per step (by directory or responsibility).\n` +
    `- Each step's description must name the specific checklist items to verify.\n` +
    `- Cover EVERY file — no file may be skipped.\n` +
    `- Keep steps ≤ 20 total.\n\n` +
    `Return ONLY valid JSON — no markdown fences, no explanation:\n` +
    `{ "steps": [{ "id": 1, "files": ["src/path.ts"], "description": "<what to check and why>" }] }`
  );
}

const AUDIT_EXECUTOR_PROMPT =
  `You are an expert code auditor.\n` +
  `Analyze the provided code carefully for the issues described.\n\n` +
  `Return ONLY valid JSON — no markdown, no explanation:\n` +
  `{ "findings": [{ "severity": "critical|high|medium|low|info", "category": "<issue type>", "file": "<relative path>", "line": <number or null>, "description": "<what the issue is and why it matters>", "recommendation": "<specific fix>" }] }\n\n` +
  `If no issues found, return: { "findings": [] }\n` +
  `Severity guide: critical=exploitable/data loss, high=significant risk, medium=should fix, low=minor, info=note.`;

// ─── Finding helpers ──────────────────────────────────────────────────────────

function parseFindings(raw: string): AuditFinding[] {
  const text = raw.trim();
  const jsonStr = text.startsWith("```")
    ? text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "")
    : text;
  try {
    const parsed = JSON.parse(jsonStr) as { findings?: AuditFinding[] };
    return Array.isArray(parsed.findings) ? parsed.findings : [];
  } catch {
    // Fallback: try to find any JSON object in the response
    const match = jsonStr.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as { findings?: AuditFinding[] };
        return Array.isArray(parsed.findings) ? parsed.findings : [];
      } catch {
        return [];
      }
    }
    return [];
  }
}

function deduplicateFindings(findings: AuditFinding[]): AuditFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.file}:${f.line ?? ""}:${f.category}:${f.description.slice(0, 60)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

function sortFindings(findings: AuditFinding[]): AuditFinding[] {
  return [...findings].sort(
    (a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 5) - (SEVERITY_ORDER[b.severity] ?? 5),
  );
}

// ─── Report formatters ────────────────────────────────────────────────────────

const SEVERITY_STYLE: Record<Severity, (s: string) => string> = {
  critical: (s) => chalk.bgRed.white.bold(s),
  high: (s) => chalk.red.bold(s),
  medium: (s) => chalk.yellow(s),
  low: (s) => chalk.gray(s),
  info: (s) => chalk.dim(s),
};

function formatTerminal(
  findings: AuditFinding[],
  types: AuditType[],
  auditedFiles: number,
): void {
  const counts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };

  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;

  const typeLabel = types.join(" + ");
  console.log(
    chalk.bold.cyan(`\n── Audit Report [${typeLabel}] ─────────────────────────────`),
  );
  console.log(chalk.gray(`   ${auditedFiles} file(s) analysed · ${findings.length} finding(s)\n`));

  if (findings.length === 0) {
    console.log(chalk.green("  No issues found.\n"));
  } else {
    for (const f of findings) {
      const severityBadge = SEVERITY_STYLE[f.severity](`[${f.severity.toUpperCase()}]`);
      const location = f.line ? `${f.file}:${f.line}` : f.file;
      console.log(`${severityBadge} ${chalk.bold(f.category)}  ${chalk.gray(location)}`);
      console.log(`  ${f.description}`);
      console.log(chalk.green(`  → ${f.recommendation}`));
      console.log();
    }
  }

  const summary = (["critical", "high", "medium", "low", "info"] as Severity[])
    .map((s) => {
      const n = counts[s];
      if (n === 0) return null;
      return SEVERITY_STYLE[s](`${n} ${s}`);
    })
    .filter(Boolean)
    .join(chalk.gray(" · "));

  console.log(chalk.bold.cyan("─────────────────────────────────────────────────────────"));
  console.log(`  ${summary || chalk.green("0 issues")}`);
  console.log();
}

function formatMarkdown(
  findings: AuditFinding[],
  types: AuditType[],
  auditedFiles: number,
): string {
  const lines: string[] = [
    `# Audit Report — ${types.join(", ")}`,
    "",
    `**Files analysed:** ${auditedFiles}  **Findings:** ${findings.length}`,
    "",
  ];

  if (findings.length === 0) {
    lines.push("No issues found.");
    return lines.join("\n");
  }

  const bySeverity: Partial<Record<Severity, AuditFinding[]>> = {};
  for (const f of findings) {
    (bySeverity[f.severity] ??= []).push(f);
  }

  for (const sev of ["critical", "high", "medium", "low", "info"] as Severity[]) {
    const group = bySeverity[sev];
    if (!group?.length) continue;
    lines.push(`## ${sev.charAt(0).toUpperCase() + sev.slice(1)} (${group.length})`);
    lines.push("");
    for (const f of group) {
      const loc = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
      lines.push(`### ${f.category} — ${loc}`);
      lines.push(`**Issue:** ${f.description}`);
      lines.push(`**Fix:** ${f.recommendation}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ─── Main command ─────────────────────────────────────────────────────────────

export async function runAudit(
  rootDir: string,
  options: AuditOptions = {},
): Promise<void> {
  const config = loadConfig(rootDir);

  if (!config.summarization) {
    console.error(
      chalk.red(
        'No LLM configured. Add a "summarization" block to .vemora/config.json.',
      ),
    );
    process.exit(1);
  }

  const types = options.types ?? (["security", "performance", "bugs"] as AuditType[]);
  const budget = options.budget ?? 5000;

  const plannerConfig: SummarizationConfig = config.planner ?? config.summarization;
  const executorConfig: SummarizationConfig = config.executor ?? config.summarization;

  const planner = createLLMProvider(plannerConfig);
  const executor = createLLMProvider(executorConfig);

  const sameLLM =
    plannerConfig.provider === executorConfig.provider &&
    plannerConfig.model === executorConfig.model;

  console.log(chalk.bold.cyan("\n[vemora audit]"));
  console.log(chalk.gray(`  Types:    ${types.join(", ")}`));
  console.log(
    chalk.gray(
      `  Planner:  ${planner.name} · ${plannerConfig.model}${sameLLM ? " (also executor)" : ""}`,
    ),
  );
  if (!sameLLM) {
    console.log(chalk.gray(`  Executor: ${executor.name} · ${executorConfig.model}`));
  }

  // ── Load index data ────────────────────────────────────────────────────────

  const repo = new RepositoryStorage(rootDir);
  const cacheStorage = new EmbeddingCacheStorage(config.projectId);
  const summaryStorage = new SummaryStorage(rootDir);

  const chunks = repo.loadChunks();
  if (chunks.length === 0) {
    console.error(chalk.red("No index found. Run `vemora index` first."));
    process.exit(1);
  }

  const symbols: SymbolIndex = repo.loadSymbols();
  const depGraph: DependencyGraph = repo.loadDeps();
  const callGraph: CallGraph = repo.loadCallGraph();
  const fileSummaries: FileSummaryIndex = summaryStorage.hasFileSummaries()
    ? summaryStorage.loadFileSummaries()
    : {};
  const projectOverview = summaryStorage.loadProjectSummary()?.overview ?? null;
  const knowledgeEntries: KnowledgeEntry[] = new KnowledgeStorage(rootDir).load();

  // ── Determine file scope ───────────────────────────────────────────────────

  let targetFiles: string[] = Object.keys(
    Object.keys(fileSummaries).length > 0
      ? fileSummaries
      : repo.loadFiles(),
  );

  if (options.since) {
    const changed = getChangedFiles(options.since, rootDir);
    if (changed.length === 0) {
      console.log(chalk.yellow(`  No changed files since ${options.since}.`));
      return;
    }
    // Keep only indexed files that appear in the diff
    const changedSet = new Set(changed);
    targetFiles = targetFiles.filter((f) => changedSet.has(f));
    if (targetFiles.length === 0) {
      console.log(chalk.yellow("  No indexed files in the diff — nothing to audit."));
      return;
    }
    console.log(chalk.gray(`  Scope:    ${changed.length} changed file(s) since ${options.since}`));
  }

  console.log(chalk.gray(`  Files:    ${targetFiles.length}`));
  console.log();

  // ── Build planner context (summaries + file list, no raw code) ─────────────

  const fileListSection = targetFiles
    .map((f) => {
      const summary = fileSummaries[f]?.summary;
      return summary ? `${f} — ${summary}` : f;
    })
    .join("\n");

  const plannerContext =
    `# Project: ${config.projectName}\n\n` +
    (projectOverview ? `## Overview\n${projectOverview}\n\n` : "") +
    `## Files to audit (${targetFiles.length})\n${fileListSection}`;

  // ── Phase 1: generate audit plan ───────────────────────────────────────────

  const planSpinner = ora("Generating audit plan...").start();
  let steps: AuditStep[] = [];

  try {
    const plannerResponse = await planner.chat(
      [
        {
          role: "system",
          content: buildAuditPlannerPrompt(types, targetFiles.length),
        },
        {
          role: "user",
          content: `Generate the audit plan for this project:\n\n${plannerContext}`,
        },
      ],
      { model: plannerConfig.model, temperature: 0.1 },
    );

    const raw = plannerResponse.content.trim();
    const jsonStr = raw.startsWith("```")
      ? raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "")
      : raw;

    const plan = JSON.parse(jsonStr) as { steps: AuditStep[] };
    steps = plan.steps ?? [];

    if (steps.length === 0) throw new Error("Plan has no steps");

    planSpinner.succeed(
      `Audit plan ready — ${steps.length} step${steps.length !== 1 ? "s" : ""}`,
    );
  } catch (err) {
    planSpinner.fail(`Planning failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // ── Phase 2: execute steps in parallel waves of 3 ─────────────────────────

  const allFindings: AuditFinding[] = [];
  const contextCache = new Map<string, string>();
  const WAVE_SIZE = 3;

  for (let i = 0; i < steps.length; i += WAVE_SIZE) {
    const wave = steps.slice(i, i + WAVE_SIZE);
    const waveLabel = `[${i + 1}-${Math.min(i + WAVE_SIZE, steps.length)}/${steps.length}]`;
    const waveSpinner = ora(
      `${waveLabel} ${wave.map((s) => s.description.slice(0, 40)).join(" | ")}...`,
    ).start();

    const waveResults = await Promise.all(
      wave.map(async (step) => {
        // Context retrieval with deduplication
        const cacheKey = JSON.stringify([...step.files].sort());
        let contextStr = contextCache.get(cacheKey);

        if (!contextStr) {
          // Targeted retrieval: pull chunks for these exact files
          const fileSet = new Set(step.files);
          let results: SearchResult[] = chunks
            .filter((c) => fileSet.has(c.file))
            .map((chunk) => ({
              chunk,
              score: 1,
              symbol: chunk.symbol ? symbols[chunk.symbol] : undefined,
            }));

          // Fallback to keyword search if targeted retrieval is empty
          if (results.length === 0) {
            results = computeBM25Scores(
              step.description,
              chunks,
              symbols,
              10,
            );
          }

          results = applyTokenBudget(results, budget);

          contextStr = generateContextString(
            config,
            results,
            depGraph,
            callGraph,
            fileSummaries,
            projectOverview,
            { query: step.description, format: "plain" },
            rootDir,
            chunks,
            knowledgeEntries,
          );

          contextCache.set(cacheKey, contextStr);
        }

        try {
          const response = await executor.chat(
            [
              {
                role: "system",
                content: `${AUDIT_EXECUTOR_PROMPT}\n\n${contextStr}`,
              },
              {
                role: "user",
                content:
                  `Audit these files: ${step.files.join(", ")}\n\n` +
                  `Focus on: ${step.description}`,
              },
            ],
            { model: executorConfig.model, temperature: 0.1 },
          );

          return parseFindings(response.content);
        } catch {
          return [] as AuditFinding[];
        }
      }),
    );

    for (const findings of waveResults) {
      allFindings.push(...findings);
    }

    const waveCount = waveResults.flat().length;
    waveSpinner.succeed(
      `${waveLabel} done — ${waveCount} finding${waveCount !== 1 ? "s" : ""}`,
    );
  }

  // ── Phase 3: aggregate, deduplicate, sort ─────────────────────────────────

  const finalFindings = sortFindings(deduplicateFindings(allFindings));

  // ── Phase 4: output ────────────────────────────────────────────────────────

  const outputFormat = options.output ?? "terminal";

  if (outputFormat === "json") {
    console.log(JSON.stringify({ findings: finalFindings }, null, 2));
  } else if (outputFormat === "markdown") {
    console.log(formatMarkdown(finalFindings, types, targetFiles.length));
  } else {
    formatTerminal(finalFindings, types, targetFiles.length);
  }

  // ── Phase 5: optionally save critical/high findings as knowledge ───────────

  if (options.save) {
    const important = finalFindings.filter(
      (f) => f.severity === "critical" || f.severity === "high",
    );
    if (important.length > 0) {
      const knowledge = new KnowledgeStorage(rootDir);
      const entries = knowledge.load();
      for (const f of important) {
        entries.push({
          id: Math.random().toString(36).slice(2),
          category: "gotcha",
          title: `[${f.severity.toUpperCase()}] ${f.category} — ${f.file}`,
          body: `${f.description}\n\nRecommendation: ${f.recommendation}`,
          relatedFiles: [f.file],
          createdAt: new Date().toISOString(),
          createdBy: `llm:${executorConfig.model}`,
          confidence: f.severity === "critical" ? "high" : "medium",
        });
      }
      knowledge.save(entries);
      console.log(
        chalk.green(
          `  ${important.length} critical/high finding(s) saved to knowledge store.`,
        ),
      );
    }
  }
}

import chalk from "chalk";
import { exec } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import ora from "ora";
import readline from "readline";
import { promisify } from "util";
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
import { createEmbeddingProvider } from "../embeddings/factory";
import { createLLMProvider } from "../llm/factory";
import type { LLMProvider } from "../llm/provider";
import { computeBM25Scores } from "../search/bm25";
import { vectorSearch } from "../search/vector";
import { EmbeddingCacheStorage } from "../storage/cache";
import { KnowledgeStorage } from "../storage/knowledge";
import { type PlanSession, PlanSessionStorage } from "../storage/planSession";
import { RepositoryStorage } from "../storage/repository";
import { SummaryStorage } from "../storage/summaries";
import { applyTokenBudget } from "../utils/tokenizer";
import { generateContextString } from "./context";

const execAsync = promisify(exec);

// ─── Public options ───────────────────────────────────────────────────────────

export interface PlanOptions {
  /** Number of chunks to retrieve per step when falling back to search (default: 5) */
  topK?: number;
  /** Force keyword/BM25 search, skip embeddings */
  keyword?: boolean;
  /** Max tokens per step context (default: 4000) */
  budget?: number;
  /** Print retrieved context for each step */
  showContext?: boolean;
  /** Show the plan and ask for confirmation before executing */
  confirm?: boolean;
  /** After all steps, call the planner again to synthesize a final answer */
  synthesize?: boolean;
  /** Have the planner verify executor outputs (write steps) before applying */
  verify?: boolean;
  /** Apply diffs produced by write steps to the filesystem */
  apply?: boolean;
  /** Max planner→executor retry cycles per write step when verify rejects (default: 2) */
  maxRetries?: number;
  /** Resume a previous session by ID or 8-char prefix */
  resumeSession?: string;
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface PlanStep {
  id: number;
  /**
   * read     — pull code context, no LLM call (zero executor tokens)
   * analyze  — executor answers in prose (default)
   * write    — executor produces a unified diff
   * test     — run `command` in a shell; no LLM call
   */
  action?: "read" | "analyze" | "write" | "test";
  /** Shell command to run for action:"test" */
  command?: string;
  /** Fallback search query when files/symbols are not specified */
  query: string;
  /** Targeted files to pull directly from the index */
  files?: string[];
  /** Targeted symbol names to pull directly from the index */
  symbols?: string[];
  /** IDs of prior steps whose results should be injected as context */
  dependsOn?: number[];
  goal: string;
  instruction: string;
}

interface Plan {
  goal: string;
  steps: PlanStep[];
}

interface StepResult {
  stepId: number;
  answer: string;
  insufficient: boolean;
  /** True when output was already streamed to stdout — skip re-printing */
  streamed?: boolean;
}

// ─── Shared data loaded once ──────────────────────────────────────────────────

interface IndexData {
  chunks: Chunk[];
  symbols: SymbolIndex;
  depGraph: DependencyGraph;
  callGraph: CallGraph;
  fileSummaries: FileSummaryIndex;
  projectOverview: string | null;
  knowledgeEntries: KnowledgeEntry[];
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

const PLANNER_SYSTEM_PROMPT = `You are an expert software architect.
Decompose a complex codebase task into a concrete step-by-step plan for a smaller model to execute.

Available step actions:
  read    — pull code into context with no LLM call (free; use to share files across steps)
  analyze — executor answers a question in prose (default)
  write   — executor produces a unified diff (use for code changes)
  test    — run a shell command and capture its output (use to verify changes)

Guidelines:
- Each step must be atomic and focused on a single concern.
- Prefer "files" and "symbols" over "query" — direct retrieval is faster and cheaper.
- Use "dependsOn" when a step needs the output of a prior step.
- Use action:"read" to share a file's content with later write/analyze steps.
- Use action:"write" for code changes; the executor will produce a unified diff.
- Use action:"test" with a "command" field to verify changes.
- If unsure of exact file paths, use "query" as fallback.
- Keep steps ≤ 7 unless truly necessary.

Return ONLY valid JSON — no markdown fences, no explanation:
{
  "goal": "<one-line summary>",
  "steps": [
    {
      "id": 1,
      "action": "read|analyze|write|test",
      "goal": "<what this step determines or produces>",
      "instruction": "<precise instruction for the executor>",
      "files": ["src/path/to/file.ts"],
      "symbols": ["SymbolName"],
      "query": "<fallback search query>",
      "dependsOn": [],
      "command": "<shell command, only for action:test>"
    }
  ]
}`;

const EXECUTOR_ANALYZE_PROMPT =
  "You are an expert software engineer. " +
  "Answer the specific question using ONLY the provided code context. " +
  "Be concise and technical. Reference file paths and symbol names when relevant.\n" +
  "If context is insufficient, start your response with INSUFFICIENT: and describe what is missing.";

const EXECUTOR_WRITE_PROMPT =
  "You are an expert software engineer. " +
  "Produce the code changes requested as a unified diff.\n\n" +
  "Rules:\n" +
  "- Output ONLY the diff, no explanation before or after.\n" +
  "- Use standard unified diff format: --- a/path and +++ b/path headers.\n" +
  "- Include 3 lines of context around each change.\n" +
  "- If context is insufficient to produce a correct diff, start with INSUFFICIENT: and describe what is missing.";

const SYNTHESIZER_SYSTEM_PROMPT =
  "You are an expert software engineer. " +
  "Synthesize the results from multiple analysis steps into a single, coherent, well-structured answer. " +
  "Avoid repeating information. Be concise and precise.";

const REPLAN_SYSTEM_PROMPT =
  "You are an expert software architect. " +
  "One or more steps in a plan failed because the executor had insufficient context. " +
  "Provide 1-3 additional steps to recover the missing information.\n\n" +
  "Return ONLY valid JSON — no markdown fences:\n" +
  '{ "steps": [{ "id": <next_id>, "action": "read|analyze", "goal": "...", "instruction": "...", "files": [], "symbols": [], "query": "...", "dependsOn": [<failed_step_id>] }] }';

const VERIFIER_SYSTEM_PROMPT =
  "You are an expert software architect reviewing code changes produced by an AI executor. " +
  "Your job is to verify that the executor's output correctly implements the requested goal.\n\n" +
  "Review the diff for:\n" +
  "- Correctness: does it faithfully implement the goal and instruction?\n" +
  "- Completeness: are there obvious missing pieces?\n" +
  "- Safety: are there apparent bugs, regressions, or unsafe changes?\n\n" +
  "Respond with EXACTLY one of the following two options (no other text):\n" +
  "APPROVED\n" +
  "NEEDS_REVISION: <specific, actionable feedback for the executor to address>\n\n" +
  "Be concise. The executor will retry with your feedback injected into its prompt.";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Topological sort into waves — each wave can run in parallel. */
function buildExecutionWaves(steps: PlanStep[]): PlanStep[][] {
  const waves: PlanStep[][] = [];
  const resolved = new Set<number>();
  let remaining = [...steps];

  while (remaining.length > 0) {
    const wave = remaining.filter((s) =>
      (s.dependsOn ?? []).every((id) => resolved.has(id)),
    );
    if (wave.length === 0) break; // circular dependency guard
    for (const s of wave) resolved.add(s.id);
    remaining = remaining.filter((s) => !wave.some((w) => w.id === s.id));
    waves.push(wave);
  }

  return waves;
}

/** Cache key for context deduplication within a session. */
function contextCacheKey(step: PlanStep): string {
  return JSON.stringify({
    f: [...(step.files ?? [])].sort(),
    s: [...(step.symbols ?? [])].sort(),
    q: step.query,
  });
}

/** Prompt the user for y/n confirmation. */
async function askConfirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "y" || a === "yes" || a === "");
    });
  });
}

/**
 * Extract the first valid JSON object from a response that may contain
 * surrounding prose, markdown code fences, or both.
 * Priority: code fence → brace-delimited object → raw string.
 */
function extractJson(raw: string): string {
  // 1. Try markdown code fence (```json ... ``` or ``` ... ```)
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // 2. Try to find the outermost { ... } block
  const start = raw.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    for (let i = start; i < raw.length; i++) {
      if (raw[i] === "{") depth++;
      else if (raw[i] === "}") {
        depth--;
        if (depth === 0) return raw.slice(start, i + 1);
      }
    }
  }

  // 3. Fallback — let JSON.parse produce the error
  return raw;
}

/** Display the plan in a human-readable table before execution. */
function displayPlan(plan: Plan, steps: PlanStep[]): void {
  const actionColor: Record<string, (s: string) => string> = {
    read: chalk.blue,
    analyze: chalk.gray,
    write: chalk.green,
    test: chalk.magenta,
  };

  console.log(chalk.bold(`\nGoal: ${plan.goal}\n`));

  for (const step of steps) {
    const action = step.action ?? "analyze";
    const badge = (actionColor[action] ?? chalk.gray)(`[${action}]`);
    const targets =
      (step.files?.length ?? 0) + (step.symbols?.length ?? 0) > 0
        ? chalk.gray(
            `  →  ${[...(step.files ?? []), ...(step.symbols ?? [])].join(", ")}`,
          )
        : step.query
          ? chalk.gray(`  →  search: "${step.query}"`)
          : "";
    const deps =
      step.dependsOn?.length
        ? chalk.gray(`  (depends on: ${step.dependsOn.join(", ")})`)
        : "";
    console.log(
      `  ${chalk.bold.yellow(String(step.id).padStart(2))}  ${badge}  ${chalk.bold(step.goal)}${targets}${deps}`,
    );
    if (action === "test" && step.command) {
      console.log(chalk.gray(`       $ ${step.command}`));
    }
  }

  console.log();
}

/**
 * Apply a unified diff to the project using `patch -p1`.
 * Writes the diff to a temp file to avoid shell stdin complexity.
 */
async function applyDiff(
  diff: string,
  rootDir: string,
  dryRun = false,
): Promise<{ success: boolean; output: string }> {
  const tmpFile = `${tmpdir()}/vemora-${Date.now()}.patch`;
  try {
    writeFileSync(tmpFile, diff, "utf-8");
    const flags = dryRun ? "--dry-run" : "";
    const { stdout, stderr } = await execAsync(
      `patch -p1 ${flags} < "${tmpFile}"`,
      { cwd: rootDir },
    );
    return { success: true, output: (stdout + stderr).trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      output: ((e.stdout ?? "") + (e.stderr ?? "") + (e.message ?? "")).trim(),
    };
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Normalize an executor's raw output into a clean unified diff:
 * - Strips markdown code fences (```diff ... ```)
 * - Strips explanation prose before the first `--- ` header
 * Returns the cleaned diff and any warnings to surface to the user.
 */
function normalizeDiff(raw: string): { diff: string; warnings: string[] } {
  const warnings: string[] = [];

  // Pass through INSUFFICIENT responses untouched
  if (raw.trimStart().startsWith("INSUFFICIENT:")) {
    return { diff: raw, warnings: [] };
  }

  let content = raw.trim();

  // Strip markdown code fences
  const fenceMatch = content.match(/^```(?:diff)?\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) {
    content = fenceMatch[1].trim();
  }

  // Strip explanation prose before the first `--- ` diff header
  const lines = content.split("\n");
  const diffStartIdx = lines.findIndex((l) => l.startsWith("--- "));

  if (diffStartIdx === -1) {
    warnings.push(
      "No diff header (--- a/file) found — executor may have produced prose instead of a unified diff",
    );
    return { diff: content, warnings };
  }

  if (diffStartIdx > 0) {
    warnings.push(
      `Stripped ${diffStartIdx} line(s) of preamble before the diff`,
    );
  }

  return { diff: lines.slice(diffStartIdx).join("\n"), warnings };
}

/**
 * Call the planner to verify a write-step diff.
 * Returns approved=true or approved=false with actionable feedback.
 */
async function verifyOutput(
  step: PlanStep,
  answer: string,
  planner: LLMProvider,
  plannerConfig: SummarizationConfig,
  plannerContext: string,
  rootDir: string,
  isClaudeCodePlanner: boolean,
): Promise<{ approved: boolean; feedback: string }> {
  const response = await planner.chat(
    [
      {
        role: "system",
        content: isClaudeCodePlanner
          ? VERIFIER_SYSTEM_PROMPT
          : `${VERIFIER_SYSTEM_PROMPT}\n\n${plannerContext}`,
      },
      {
        role: "user",
        content:
          `Goal: ${step.goal}\n\nInstruction: ${step.instruction}\n\n` +
          `Executor output:\n\`\`\`diff\n${answer}\n\`\`\``,
      },
    ],
    { model: plannerConfig.model, temperature: 0.1, projectRoot: rootDir },
  );

  const raw = response.content.trim();
  if (raw.startsWith("APPROVED")) {
    return { approved: true, feedback: "" };
  }
  const feedback = raw.startsWith("NEEDS_REVISION:")
    ? raw.slice("NEEDS_REVISION:".length).trim()
    : raw;
  return { approved: false, feedback };
}

/** Build the cheap planner context from summaries + symbol list (no raw code). */
function buildPlannerContext(
  projectName: string,
  projectOverview: string | null,
  fileSummaries: FileSummaryIndex,
  symbols: SymbolIndex,
): string {
  const lines: string[] = [`# Project: ${projectName}\n`];

  if (projectOverview) {
    lines.push("## Overview\n", projectOverview, "");
  }

  const fileEntries = Object.entries(fileSummaries);
  if (fileEntries.length > 0) {
    lines.push(`## Files (${fileEntries.length})\n`);
    for (const [file, entry] of fileEntries) {
      lines.push(`${file} — ${entry.summary}`);
    }
    lines.push("");
  }

  const symbolEntries = Object.entries(symbols);
  if (symbolEntries.length > 0) {
    lines.push(`## Symbols (${symbolEntries.length})\n`);
    for (const [name, entry] of symbolEntries) {
      lines.push(`${name} (${entry.type}) — ${entry.file}:${entry.startLine}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Retrieve and format code context for an executor step, with session-level caching. */
async function retrieveStepContext(
  step: PlanStep,
  config: ReturnType<typeof loadConfig>,
  data: IndexData,
  cacheStorage: EmbeddingCacheStorage,
  rootDir: string,
  topK: number,
  budget: number,
  forceKeyword: boolean,
  contextCache: Map<string, string>,
): Promise<string> {
  const cacheKey = contextCacheKey(step);
  const cached = contextCache.get(cacheKey);
  if (cached) return cached;

  // ── write steps: read targeted files live from disk (not stale index chunks) ─
  if ((step.action ?? "analyze") === "write" && step.files?.length) {
    const liveBlocks = step.files.map((relPath) => {
      const absPath = path.join(rootDir, relPath);
      if (existsSync(absPath)) {
        const content = readFileSync(absPath, "utf-8");
        return `## ${relPath} (live — read from disk)\n\`\`\`\n${content}\n\`\`\``;
      }
      return `## ${relPath} — FILE NOT FOUND ON DISK`;
    });
    const liveCtx = `# Current File Contents\n\n${liveBlocks.join("\n\n")}`;
    contextCache.set(cacheKey, liveCtx);
    return liveCtx;
  }

  const { chunks, symbols, depGraph, callGraph, fileSummaries, projectOverview, knowledgeEntries } = data;
  let results: SearchResult[] = [];

  const hasTargets = (step.files?.length ?? 0) + (step.symbols?.length ?? 0) > 0;

  if (hasTargets) {
    const fileSet = new Set(step.files ?? []);
    const symbolSet = new Set(step.symbols ?? []);
    const targeted = chunks.filter(
      (c) =>
        (fileSet.size > 0 && fileSet.has(c.file)) ||
        (symbolSet.size > 0 && c.symbol !== undefined && symbolSet.has(c.symbol)),
    );
    results = targeted.map((chunk) => ({
      chunk,
      score: 1,
      symbol: chunk.symbol ? symbols[chunk.symbol] : undefined,
    }));
  }

  if (results.length === 0) {
    // Guard: LLM may omit query; fall back to goal so BM25 never receives undefined
    const searchQuery = step.query ?? step.goal;
    if (forceKeyword) {
      results = computeBM25Scores(searchQuery, chunks, symbols, topK);
    } else {
      try {
        const cache = cacheStorage.load();
        const cachedCount = cache
          ? (cache.chunkIds?.length ?? Object.keys(cache.embeddings ?? {}).length)
          : 0;
        if (!cache || cachedCount === 0) {
          results = computeBM25Scores(searchQuery, chunks, symbols, topK);
        } else {
          const provider = createEmbeddingProvider(config.embedding);
          const [queryEmbedding] = await provider.embed([searchQuery]);
          results = vectorSearch(queryEmbedding, chunks, cache, symbols, topK);
          if (results.length === 0) {
            results = computeBM25Scores(searchQuery, chunks, symbols, topK);
          }
        }
      } catch {
        results = computeBM25Scores(searchQuery, chunks, symbols, topK);
      }
    }
  }

  results = applyTokenBudget(results, budget);

  const contextFormat = config.display?.format === "terse" ? "terse" : "plain";
  const contextStr = generateContextString(
    config,
    results,
    depGraph,
    callGraph,
    fileSummaries,
    projectOverview,
    { query: step.query, format: contextFormat },
    rootDir,
    chunks,
    knowledgeEntries,
  );

  contextCache.set(cacheKey, contextStr);
  return contextStr;
}

/** Execute a single step, returning its answer and whether context was insufficient. */
async function executeStep(
  step: PlanStep,
  config: ReturnType<typeof loadConfig>,
  data: IndexData,
  cacheStorage: EmbeddingCacheStorage,
  rootDir: string,
  executorConfig: SummarizationConfig,
  executor: LLMProvider,
  topK: number,
  budget: number,
  forceKeyword: boolean,
  stepResults: Map<number, string>,
  contextCache: Map<string, string>,
  showContext: boolean,
  /** Planner feedback from a previous failed attempt — injected into the executor prompt */
  feedback?: string,
  /** Stream tokens to stdout in real time (only for sequential, non-parallel steps) */
  stream?: boolean,
): Promise<StepResult> {
  const action = step.action ?? "analyze";

  // ── action: test — run shell command, no LLM ──────────────────────────────
  if (action === "test") {
    if (!step.command) {
      return { stepId: step.id, answer: "No command specified for test step.", insufficient: false };
    }
    try {
      const { stdout, stderr } = await execAsync(step.command, {
        cwd: rootDir,
        timeout: 60_000,
      });
      const answer =
        `$ ${step.command}\n\n` +
        (stdout ? `stdout:\n${stdout}` : "") +
        (stderr ? `\nstderr:\n${stderr}` : "");
      return { stepId: step.id, answer, insufficient: false };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const answer =
        `$ ${step.command} — FAILED\n\n` +
        (e.stdout ? `stdout:\n${e.stdout}\n` : "") +
        (e.stderr ? `stderr:\n${e.stderr}\n` : "") +
        (e.message ? `error: ${e.message}` : "");
      return { stepId: step.id, answer, insufficient: false };
    }
  }

  // ── retrieve context (shared cache) ──────────────────────────────────────
  const contextStr = await retrieveStepContext(
    step,
    config,
    data,
    cacheStorage,
    rootDir,
    topK,
    budget,
    forceKeyword,
    contextCache,
  );

  if (showContext) {
    console.log(chalk.gray("  ── context ──────────────────────────────────"));
    console.log(chalk.gray(contextStr));
    console.log(chalk.gray("  ─────────────────────────────────────────────\n"));
  }

  // ── action: read — return context as-is, no LLM call ─────────────────────
  if (action === "read") {
    return { stepId: step.id, answer: contextStr, insufficient: false };
  }

  // ── inject dependsOn results ──────────────────────────────────────────────
  let dependencySection = "";
  if (step.dependsOn?.length) {
    const parts: string[] = [];
    for (const depId of step.dependsOn) {
      const depResult = stepResults.get(depId);
      if (depResult) parts.push(`### Step ${depId}\n${depResult}`);
    }
    if (parts.length > 0) {
      dependencySection = `\n\n## Prior step results\n${parts.join("\n\n")}`;
    }
  }

  // ── action: analyze | write — call executor LLM ───────────────────────────
  const systemPrompt =
    action === "write" ? EXECUTOR_WRITE_PROMPT : EXECUTOR_ANALYZE_PROMPT;

  const feedbackSection = feedback
    ? `\n\n## Planner feedback from previous attempt\n${feedback}\n\nRevise your output to address this feedback.`
    : "";

  const messages = [
    { role: "system" as const, content: `${systemPrompt}\n\n${contextStr}` },
    {
      role: "user" as const,
      content: `Goal: ${step.goal}\n\nInstruction: ${step.instruction}${dependencySection}${feedbackSection}`,
    },
  ];
  const chatOpts = {
    model: executorConfig.model,
    temperature: action === "write" ? 0.1 : 0.3,
  };

  if (stream) {
    // Stream tokens directly to stdout — caller must not print the answer again
    let answer = "";
    process.stdout.write(chalk.cyan("  ↳ "));
    await executor.chat(messages, {
      ...chatOpts,
      onToken: (token) => {
        process.stdout.write(token);
        answer += token;
      },
    });
    process.stdout.write("\n\n");
    const insufficient = answer.trimStart().startsWith("INSUFFICIENT:");
    return { stepId: step.id, answer, insufficient, streamed: true };
  }

  const response = await executor.chat(messages, chatOpts);
  const answer = response.content;
  const insufficient = answer.trimStart().startsWith("INSUFFICIENT:");
  return { stepId: step.id, answer, insufficient };
}

// ─── Main command ─────────────────────────────────────────────────────────────

export async function runPlan(
  rootDir: string,
  task: string,
  options: PlanOptions = {},
): Promise<void> {
  const config = loadConfig(rootDir);

  if (!config.summarization && !config.executor) {
    console.error(
      chalk.red(
        'No executor LLM configured. Add a "summarization" or "executor" block to .vemora/config.json.',
      ),
    );
    process.exit(1);
  }

  // executor > summarization fallback; planner > executor > summarization fallback
  const executorConfig = (config.executor ?? config.summarization) as SummarizationConfig;
  const plannerConfig: SummarizationConfig = config.planner ?? executorConfig;
  const isClaudeCodePlanner = plannerConfig.provider === "claude-code";

  const topK = options.topK ?? 5;
  const budget = options.budget ?? 4000;
  const forceKeyword = options.keyword || config.embedding.provider === "none";

  // ── Load index data once ───────────────────────────────────────────────────

  const repo = new RepositoryStorage(rootDir);
  const cacheStorage = new EmbeddingCacheStorage(config.projectId);
  const summaryStorage = new SummaryStorage(rootDir);

  const chunks = repo.loadChunks();
  if (chunks.length === 0) {
    console.error(chalk.red("No index found. Run `vemora index` first."));
    process.exit(1);
  }

  const data: IndexData = {
    chunks,
    symbols: repo.loadSymbols(),
    depGraph: repo.loadDeps(),
    callGraph: repo.loadCallGraph(),
    fileSummaries: summaryStorage.hasFileSummaries()
      ? summaryStorage.loadFileSummaries()
      : {},
    projectOverview: summaryStorage.loadProjectSummary()?.overview ?? null,
    knowledgeEntries: new KnowledgeStorage(rootDir).load(),
  };

  const planner = createLLMProvider(plannerConfig);
  const executor = createLLMProvider(executorConfig);

  const sameLLM =
    plannerConfig.provider === executorConfig.provider &&
    plannerConfig.model === executorConfig.model;

  console.log(chalk.bold.cyan("\n[vemora plan]"));
  console.log(
    chalk.gray(
      `  Planner:  ${planner.name} · ${plannerConfig.model}${sameLLM ? " (also executor)" : ""}`,
    ),
  );
  if (!sameLLM) {
    console.log(chalk.gray(`  Executor: ${executor.name} · ${executorConfig.model}`));
  }

  const hasSummaries =
    data.projectOverview !== null || Object.keys(data.fileSummaries).length > 0;
  if (!hasSummaries) {
    console.log(
      chalk.yellow(
        "  Tip: run `vemora summarize` for cheaper planning (summaries replace raw code).",
      ),
    );
  }
  console.log();

  // ── Session setup (early — needed to skip planning on resume) ───────────────
  const sessionStorage = new PlanSessionStorage(config.projectId);

  // ── Phase 1 + 2: planner context + plan generation (skipped on resume) ──────

  let plan!: Plan;
  let plannerContext = "";

  if (options.resumeSession) {
    // Load saved session — plan and results are already there
    const loaded = sessionStorage.load(options.resumeSession);
    if (!loaded) {
      console.error(
        chalk.red(
          `Session "${options.resumeSession}" not found. List sessions with \`vemora sessions --root .\``,
        ),
      );
      process.exit(1);
    }
    plan = loaded.plan as unknown as Plan;
    console.log(
      chalk.cyan(
        `  Resuming session ${loaded.shortId} — reusing saved plan (${plan.steps.length} steps)`,
      ),
    );
    // Build plannerContext for verifier (still needed if --verify is set)
    plannerContext = hasSummaries
      ? buildPlannerContext(
          config.projectName,
          data.projectOverview,
          data.fileSummaries,
          data.symbols,
        )
      : "";
  } else {
    // Build planner context from summaries + symbol list (no raw code)
    plannerContext = hasSummaries
      ? buildPlannerContext(
          config.projectName,
          data.projectOverview,
          data.fileSummaries,
          data.symbols,
        )
      : generateContextString(
          config,
          applyTokenBudget(
            computeBM25Scores(task, chunks, data.symbols, topK),
            budget,
          ),
          data.depGraph,
          data.callGraph,
          data.fileSummaries,
          data.projectOverview,
          { query: task, format: "terse" },
          rootDir,
          chunks,
          data.knowledgeEntries,
        );

    // When using claude-code, skip pre-built context — Claude explores the
    // project autonomously with its file tools. For other providers, inject
    // the summaries + symbol list so they don't need filesystem access.
    const plannerMessages: Array<{ role: "system" | "user"; content: string }> =
      isClaudeCodePlanner
        ? [
            { role: "system", content: PLANNER_SYSTEM_PROMPT },
            {
              role: "user",
              content:
                `The project root is: ${rootDir}\n\n` +
                `Use your file tools (Read, Grep, Glob) to explore the codebase ` +
                `as needed, then decompose this task into concrete steps:\n\n${task}\n\n` +
                `IMPORTANT: your entire response must be a single raw JSON object ` +
                `starting with { and ending with }. No prose, no markdown, no code fences.`,
            },
          ]
        : [
            {
              role: "system",
              content: `${PLANNER_SYSTEM_PROMPT}\n\n${plannerContext}`,
            },
            {
              role: "user",
              content: `Decompose this task into concrete steps:\n\n${task}`,
            },
          ];

    const plannerSpinner = ora(
      isClaudeCodePlanner
        ? "Planning (claude-code exploring codebase)..."
        : "Planning...",
    ).start();
    try {
      const plannerResponse = await planner.chat(plannerMessages, {
        model: plannerConfig.model,
        temperature: 0.2,
        projectRoot: rootDir,
      });

      const raw = plannerResponse.content.trim();
      const jsonStr = extractJson(raw);

      plan = JSON.parse(jsonStr) as Plan;

      if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
        throw new Error("Plan has no steps");
      }

      plannerSpinner.succeed(
        `Plan ready — ${plan.steps.length} step${plan.steps.length !== 1 ? "s" : ""}`,
      );
    } catch (err) {
      plannerSpinner.fail(`Planning failed: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  // ── Phase 3: display plan + optional confirmation (skipped on resume) ────────

  if (!options.resumeSession) {
    displayPlan(plan, plan.steps);

    if (options.confirm) {
      const ok = await askConfirm(chalk.bold("Proceed with this plan? [Y/n] "));
      if (!ok) {
        console.log(chalk.gray("Aborted."));
        return;
      }
      console.log();
    }
  }

  // ── Phase 4: execute in topological waves (parallel within each wave) ──────

  const waves = buildExecutionWaves(plan.steps);
  const stepResults = new Map<number, string>();
  const contextCache = new Map<string, string>();
  let nextId = Math.max(...plan.steps.map((s) => s.id)) + 1;
  let session: PlanSession;

  if (options.resumeSession) {
    // Session was already loaded and plan restored in Phase 1/2 — just re-load to get state
    session = sessionStorage.load(options.resumeSession)!;
    for (const [k, v] of Object.entries(session.stepResults)) {
      stepResults.set(Number(k), v);
    }
    nextId = session.nextId;
    console.log(
      chalk.cyan(
        `  ${session.completedStepIds.length} step(s) already complete — continuing from wave boundary\n`,
      ),
    );
  } else {
    const sessionId = randomUUID();
    session = {
      sessionId,
      shortId: sessionId.slice(0, 8),
      task,
      rootDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "running",
      plan: plan as unknown as PlanSession["plan"],
      stepResults: {},
      completedStepIds: [],
      nextId,
    };
    sessionStorage.save(session);
    console.log(
      chalk.gray(
        `  Session: ${session.shortId}  (use --resume ${session.shortId} to continue if interrupted)\n`,
      ),
    );
  }

  for (const wave of waves) {
    // Skip waves whose steps are all already done (resume path)
    if (wave.every((s) => stepResults.has(s.id))) {
      const ids = wave.map((s) => s.id).join(", ");
      console.log(
        chalk.gray(
          `  ── step${wave.length > 1 ? "s" : ""} [${ids}] already complete — skipping ──`,
        ),
      );
      continue;
    }
    const isParallel = wave.length > 1;
    if (isParallel) {
      console.log(
        chalk.gray(
          `── parallel wave (${wave.length} steps: ${wave.map((s) => s.id).join(", ")}) ──`,
        ),
      );
    }

    const waveSpinners = wave.map((step) => {
      const action = step.action ?? "analyze";
      const badge = { read: "📖", analyze: "🔍", write: "✏️", test: "🧪" }[action] ?? "•";
      const label = `${badge} [${step.id}] ${step.goal}`;
      return isParallel ? ora(`  ${label}`).start() : null;
    });

    if (!isParallel) {
      const step = wave[0];
      const action = step.action ?? "analyze";
      const badge = { read: chalk.blue, analyze: chalk.gray, write: chalk.green, test: chalk.magenta }[action] ?? chalk.gray;
      const targets =
        (step.files?.length ?? 0) + (step.symbols?.length ?? 0) > 0
          ? chalk.gray(` [${[...(step.files ?? []), ...(step.symbols ?? [])].join(", ")}]`)
          : "";
      console.log(
        `${chalk.bold.yellow(`[${step.id}/${plan.steps.length}]`)} ${badge(`[${action}]`)} ${chalk.bold(step.goal)}${targets}`,
      );
    }

    const waveResults = await Promise.all(
      wave.map((step, i) =>
        executeStep(
          step,
          config,
          data,
          cacheStorage,
          rootDir,
          executorConfig,
          executor,
          topK,
          budget,
          forceKeyword,
          stepResults,
          contextCache,
          options.showContext ?? false,
          undefined,       // feedback — none on first attempt
          !isParallel,     // stream — only for sequential steps
        ).then((result) => {
          waveSpinners[i]?.succeed(`  [${step.id}] ${step.goal}`);
          return result;
        }).catch((err) => {
          waveSpinners[i]?.fail(`  [${step.id}] ${step.goal}`);
          return { stepId: step.id, answer: `Error: ${(err as Error).message}`, insufficient: false, streamed: false };
        }),
      ),
    );

    for (const result of waveResults) {
      stepResults.set(result.stepId, result.answer);
      // Skip printing if already streamed to stdout
      if (!isParallel && !result.streamed) {
        const indented = result.answer.replace(/\n/g, "\n  ");
        console.log(`  ${indented}\n`);
      }
    }

    if (isParallel) {
      for (const result of waveResults) {
        const step = wave.find((s) => s.id === result.stepId)!;
        console.log(chalk.bold.yellow(`\n  [${step.id}] ${step.goal}`));
        console.log(`  ${result.answer.replace(/\n/g, "\n  ")}\n`);
      }
    }

    // ── Verify + retry + apply: handle write steps ────────────────────────────

    if (options.verify || options.apply) {
      const maxRetries = options.maxRetries ?? 2;

      for (const result of waveResults) {
        const step = wave.find((s) => s.id === result.stepId)!;
        if ((step.action ?? "analyze") !== "write") continue;
        if (result.insufficient) continue;

        // Normalize the diff (strip code fences, preamble) before verify/apply
        const { diff: normalizedDiff, warnings: diffWarnings } = normalizeDiff(result.answer);
        if (diffWarnings.length > 0) {
          for (const w of diffWarnings) console.log(chalk.yellow(`  ⚠  ${w}`));
        }
        let currentAnswer = normalizedDiff;
        let approved = !options.verify; // auto-approve when not verifying

        if (options.verify) {
          const verifySpinner = ora(
            `  Verifying [${step.id}] ${step.goal}...`,
          ).start();

          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            let verdict: { approved: boolean; feedback: string };
            try {
              verdict = await verifyOutput(
                step,
                currentAnswer,
                planner,
                plannerConfig,
                plannerContext,
                rootDir,
                isClaudeCodePlanner,
              );
            } catch (err) {
              verifySpinner.warn(
                `  [${step.id}] Verifier error: ${(err as Error).message}`,
              );
              break;
            }

            if (verdict.approved) {
              verifySpinner.succeed(
                `  [${step.id}] ${chalk.green("Approved")} by planner`,
              );
              approved = true;
              break;
            }

            if (attempt === maxRetries) {
              verifySpinner.warn(
                `  [${step.id}] ${chalk.yellow("Rejected")} after ${maxRetries + 1} attempt(s) — not applying`,
              );
              console.log(
                chalk.yellow(`  Planner feedback: ${verdict.feedback}`),
              );
              break;
            }

            verifySpinner.text = `  [${step.id}] Needs revision (attempt ${attempt + 2}/${maxRetries + 1})...`;
            console.log(
              chalk.yellow(`\n  Planner feedback: ${verdict.feedback}`),
            );

            // Re-run executor with planner feedback injected
            const retryResult = await executeStep(
              step,
              config,
              data,
              cacheStorage,
              rootDir,
              executorConfig,
              executor,
              topK,
              budget,
              forceKeyword,
              stepResults,
              contextCache,
              options.showContext ?? false,
              verdict.feedback,
            );

            const { diff: retryDiff, warnings: retryWarnings } = normalizeDiff(retryResult.answer);
            if (retryWarnings.length > 0) {
              for (const w of retryWarnings) console.log(chalk.yellow(`  ⚠  ${w}`));
            }
            currentAnswer = retryDiff;
            stepResults.set(retryResult.stepId, currentAnswer);
            const indented = currentAnswer.replace(/\n/g, "\n  ");
            console.log(chalk.gray(`\n  Revised output:\n  ${indented}\n`));
          }
        }

        // Apply diff to filesystem
        if (options.apply) {
          if (approved) {
            const applySpinner = ora(
              `  Applying diff for step [${step.id}]...`,
            ).start();
            const { success, output } = await applyDiff(
              currentAnswer,
              rootDir,
            );
            if (success) {
              applySpinner.succeed(`  [${step.id}] Diff applied`);
              if (output) console.log(chalk.gray(`  ${output}`));
            } else {
              applySpinner.fail(`  [${step.id}] Diff apply failed`);
              console.log(chalk.red(`  ${output}`));
            }
          } else {
            console.log(
              chalk.yellow(
                `  [${step.id}] Diff NOT applied (verification rejected).`,
              ),
            );
          }
        } else if (approved) {
          console.log(
            chalk.gray(
              `  Tip: add --apply to automatically patch the filesystem.`,
            ),
          );
        }
      }
    }

    // ── Adaptive re-planning: handle INSUFFICIENT steps ────────────────────

    const insufficientSteps = waveResults.filter((r) => r.insufficient);
    if (insufficientSteps.length > 0) {
      const replanSpinner = ora(
        `  Re-planning for ${insufficientSteps.length} insufficient step(s)...`,
      ).start();

      const failedSummary = insufficientSteps
        .map((r) => {
          const step = wave.find((s) => s.id === r.stepId)!;
          return `Step ${r.stepId} (${step.goal}):\n${r.answer}`;
        })
        .join("\n\n");

      try {
        const replanResponse = await planner.chat(
          [
            {
              role: "system",
              content: isClaudeCodePlanner
                ? REPLAN_SYSTEM_PROMPT
                : `${REPLAN_SYSTEM_PROMPT}\n\n${plannerContext}`,
            },
            {
              role: "user",
              content:
                `The following steps reported insufficient context:\n\n${failedSummary}\n\n` +
                `Next available step ID: ${nextId}. ` +
                `Provide remediation steps to gather the missing information.`,
            },
          ],
          { model: plannerConfig.model, temperature: 0.2, projectRoot: rootDir },
        );

        const raw = replanResponse.content.trim();
        const jsonStr = raw.startsWith("```")
          ? raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "")
          : raw;

        const replan = JSON.parse(jsonStr) as { steps: PlanStep[] };

        if (Array.isArray(replan.steps) && replan.steps.length > 0) {
          // Reassign IDs to avoid collisions
          const remediationSteps = replan.steps.map((s, i) => ({
            ...s,
            id: nextId + i,
          }));
          nextId += remediationSteps.length;

          replanSpinner.succeed(
            `  Re-plan: ${remediationSteps.length} remediation step(s) added`,
          );

          // Execute remediation steps immediately (as a new wave)
          const remediationWaves = buildExecutionWaves(remediationSteps);
          for (const remWave of remediationWaves) {
            const remResults = await Promise.all(
              remWave.map((step) =>
                executeStep(
                  step,
                  config,
                  data,
                  cacheStorage,
                  rootDir,
                  executorConfig,
                  executor,
                  topK,
                  budget,
                  forceKeyword,
                  stepResults,
                  contextCache,
                  options.showContext ?? false,
                ),
              ),
            );
            for (const r of remResults) {
              stepResults.set(r.stepId, r.answer);
              const step = remWave.find((s) => s.id === r.stepId)!;
              console.log(chalk.bold.yellow(`\n  [${step.id}ᴿ] ${step.goal}`));
              console.log(`  ${r.answer.replace(/\n/g, "\n  ")}\n`);
            }
          }
        } else {
          replanSpinner.warn("  Re-plan returned no steps.");
        }
      } catch {
        replanSpinner.warn("  Re-planning failed — continuing.");
      }
    }

    // ── Persist session state after every wave ─────────────────────────────
    session.stepResults = Object.fromEntries(
      Array.from(stepResults.entries()).map(([k, v]) => [String(k), v]),
    );
    session.completedStepIds = Array.from(stepResults.keys());
    session.nextId = nextId;
    session.updatedAt = new Date().toISOString();
    sessionStorage.save(session);
  }

  // Mark session complete before synthesis
  session.status = "completed";
  session.updatedAt = new Date().toISOString();
  sessionStorage.save(session);

  // ── Phase 5: optional synthesis ────────────────────────────────────────────

  let synthesisText = "";

  if (options.synthesize && stepResults.size > 0) {
    const synthSpinner = ora("Synthesizing final answer...").start();

    const stepSummaries = plan.steps
      .map((s) => {
        const result = stepResults.get(s.id);
        return result ? `### Step ${s.id}: ${s.goal}\n${result}` : null;
      })
      .filter(Boolean)
      .join("\n\n");

    try {
      const response = await planner.chat(
        [
          { role: "system", content: SYNTHESIZER_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Original task: ${task}\n\n## Step results\n\n${stepSummaries}\n\nSynthesize a final, complete answer.`,
          },
        ],
        { model: plannerConfig.model, temperature: 0.3 },
      );

      synthesisText = response.content;
      synthSpinner.succeed("Synthesis complete");
      console.log(
        chalk.bold.cyan("\n── Final answer ────────────────────────────────\n"),
      );
      console.log(synthesisText);
      console.log(
        chalk.gray("\n────────────────────────────────────────────────"),
      );
    } catch (err) {
      synthSpinner.fail(`Synthesis error: ${(err as Error).message}`);
    }
  }

  // ── Phase 6: offer to save synthesis as knowledge entry ───────────────────

  if (synthesisText && options.synthesize) {
    const save = await askConfirm(
      chalk.bold("\nSave synthesis as a knowledge entry? [y/N] "),
    );
    if (save) {
      const knowledge = new KnowledgeStorage(rootDir);
      const entries = knowledge.load();
      entries.push({
        id: randomUUID(),
        category: "pattern",
        title: plan.goal,
        body: synthesisText,
        createdAt: new Date().toISOString(),
        createdBy: `llm:${plannerConfig.model}`,
        confidence: "medium",
      });
      knowledge.save(entries);
      console.log(chalk.green("  Saved."));
    }
  }

  console.log(
    chalk.gray(
      `\nPlan complete: ${stepResults.size} step(s) executed` +
        (options.synthesize ? " + synthesis" : ""),
    ),
  );
}

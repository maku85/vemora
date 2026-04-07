import chalk from "chalk";
import { exec } from "child_process";
import { randomUUID } from "crypto";
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
    if (forceKeyword) {
      results = computeBM25Scores(step.query, chunks, symbols, topK);
    } else {
      try {
        const cache = cacheStorage.load();
        const cachedCount = cache
          ? (cache.chunkIds?.length ?? Object.keys(cache.embeddings ?? {}).length)
          : 0;
        if (!cache || cachedCount === 0) {
          results = computeBM25Scores(step.query, chunks, symbols, topK);
        } else {
          const provider = createEmbeddingProvider(config.embedding);
          const [queryEmbedding] = await provider.embed([step.query]);
          results = vectorSearch(queryEmbedding, chunks, cache, symbols, topK);
          if (results.length === 0) {
            results = computeBM25Scores(step.query, chunks, symbols, topK);
          }
        }
      } catch {
        results = computeBM25Scores(step.query, chunks, symbols, topK);
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

  const response = await executor.chat(
    [
      { role: "system", content: `${systemPrompt}\n\n${contextStr}` },
      {
        role: "user",
        content: `Goal: ${step.goal}\n\nInstruction: ${step.instruction}${dependencySection}`,
      },
    ],
    {
      model: executorConfig.model,
      temperature: action === "write" ? 0.1 : 0.3,
    },
  );

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

  if (!config.summarization) {
    console.error(
      chalk.red(
        'No executor LLM configured. Add a "summarization" block to .vemora/config.json.',
      ),
    );
    process.exit(1);
  }

  // config.summarization is guaranteed non-undefined here (checked above)
  const executorConfig = config.summarization as SummarizationConfig;
  const plannerConfig: SummarizationConfig = config.planner ?? executorConfig;

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

  // ── Phase 1: build planner context (summaries + symbols, no raw code) ──────

  const plannerSpinner = ora("Planning...").start();

  const plannerContext = hasSummaries
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

  // ── Phase 2: call planner ──────────────────────────────────────────────────

  // definite assignment: process.exit(1) in catch guarantees assignment
  let plan!: Plan;

  try {
    const plannerResponse = await planner.chat(
      [
        {
          role: "system",
          content: `${PLANNER_SYSTEM_PROMPT}\n\n${plannerContext}`,
        },
        {
          role: "user",
          content: `Decompose this task into concrete steps:\n\n${task}`,
        },
      ],
      { model: plannerConfig.model, temperature: 0.2 },
    );

    const raw = plannerResponse.content.trim();
    const jsonStr = raw.startsWith("```")
      ? raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "")
      : raw;

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

  // ── Phase 3: display plan + optional confirmation ──────────────────────────

  displayPlan(plan, plan.steps);

  if (options.confirm) {
    const ok = await askConfirm(chalk.bold("Proceed with this plan? [Y/n] "));
    if (!ok) {
      console.log(chalk.gray("Aborted."));
      return;
    }
    console.log();
  }

  // ── Phase 4: execute in topological waves (parallel within each wave) ──────

  const waves = buildExecutionWaves(plan.steps);
  const stepResults = new Map<number, string>();
  const contextCache = new Map<string, string>();
  let nextId = Math.max(...plan.steps.map((s) => s.id)) + 1;

  for (const wave of waves) {
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
        ).then((result) => {
          waveSpinners[i]?.succeed(`  [${step.id}] ${step.goal}`);
          return result;
        }).catch((err) => {
          waveSpinners[i]?.fail(`  [${step.id}] ${step.goal}`);
          return { stepId: step.id, answer: `Error: ${(err as Error).message}`, insufficient: false };
        }),
      ),
    );

    for (const result of waveResults) {
      stepResults.set(result.stepId, result.answer);
      if (!isParallel) {
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
              content: `${REPLAN_SYSTEM_PROMPT}\n\n${plannerContext}`,
            },
            {
              role: "user",
              content:
                `The following steps reported insufficient context:\n\n${failedSummary}\n\n` +
                `Next available step ID: ${nextId}. ` +
                `Provide remediation steps to gather the missing information.`,
            },
          ],
          { model: plannerConfig.model, temperature: 0.2 },
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
  }

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

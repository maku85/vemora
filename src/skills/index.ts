/**
 * Skill system for vemora.
 *
 * A skill is a named task archetype (debug, refactor, add-feature, …) that
 * pre-configures the context retrieval pipeline and prepends a focused
 * instruction block to the output.
 *
 * Benefits:
 *  - Narrower retrieval = fewer irrelevant tokens sent to the LLM
 *  - Task-specific defaults (topK, hybrid, mmr, …) without per-call flags
 *  - Structured "focus note" tells the LLM exactly what kind of answer is expected
 */

import type { ContextOptions } from "../commands/context";

// ─── Types ────────────────────────────────────────────────────────────────────

export const SKILL_NAMES = [
  "debug",
  "refactor",
  "add-feature",
  "security",
  "explain",
  "test",
] as const;

export type SkillName = (typeof SKILL_NAMES)[number];

export interface SkillConfig {
  name: SkillName;
  /** One-line description shown in --help output */
  description: string;
  /**
   * Default ContextOptions overrides applied when this skill is active.
   * Explicit CLI flags always win (skill values are applied first, user opts
   * are merged on top — see applySkill()).
   */
  contextDefaults: Partial<ContextOptions>;
  /**
   * Short instruction block prepended to the context output.
   * Tells the LLM what kind of reasoning to apply without using extra tokens
   * for generic boilerplate.
   */
  outputPrefix: string;
  /**
   * Knowledge entry categories to boost when filtering for this skill.
   * Used by runBrief to surface the most relevant knowledge entries first.
   */
  knowledgeCategoryBoost: string[];
}

// ─── Skill registry ───────────────────────────────────────────────────────────

const SKILLS: Record<SkillName, SkillConfig> = {
  /**
   * debug — trace errors, follow call paths, surface edge cases.
   *
   * Uses hybrid search (BM25 picks up error message strings well),
   * higher topK for broad call-path coverage, MMR to avoid showing
   * the same error path repeatedly, and includes test files in the result.
   */
  debug: {
    name: "debug",
    description: "Trace errors: call paths, error handling, test expectations",
    contextDefaults: {
      topK: 8,
      hybrid: true,
      alpha: 0.6,       // lean toward BM25 — better for error strings
      mmr: true,
      lambda: 0.7,      // high relevance, mild diversity
      merge: true,
      budget: 4500,
    },
    outputPrefix: [
      "## Skill: debug",
      "",
      "Focus on:",
      "- Error paths, exception handlers, and null/undefined guards",
      "- Call chain from the failing site upward (check callers)",
      "- Test file expectations vs actual behaviour",
      "- Async race conditions, missing awaits, promise rejections",
      "- State mutation or side-effects that could corrupt intermediate state",
      "",
      "Strategy: trace the call graph from the error site, then verify",
      "against test expectations before proposing a fix.",
    ].join("\n"),
    knowledgeCategoryBoost: ["gotcha", "pattern"],
  },

  /**
   * refactor — minimal-diff, blast-radius-aware code changes.
   *
   * Structured mode groups callers/dependents explicitly.
   * Lower budget because we care more about signatures than full bodies.
   */
  refactor: {
    name: "refactor",
    description: "Safe refactoring: callers, blast radius, minimal-diff changes",
    contextDefaults: {
      topK: 6,
      structured: true,
      mmr: true,
      lambda: 0.65,
      merge: true,
      budget: 3500,
    },
    outputPrefix: [
      "## Skill: refactor",
      "",
      "Before changing anything:",
      "- Map blast radius: who calls this, what imports it",
      "- Check for overloads, interface implementations, or re-exports",
      "- Prefer minimal-diff changes — rename in place, don't restructure",
      "",
      "Rules:",
      "- Change only what was asked; no opportunistic cleanup",
      "- Keep the public API surface identical unless the task requires changing it",
      "- After the change, verify all call-sites still compile",
    ].join("\n"),
    knowledgeCategoryBoost: ["decision", "pattern"],
  },

  /**
   * add-feature — discover patterns, types, and extension points.
   *
   * Structured mode surfaces interfaces/types early.
   * Higher topK to capture related patterns across the codebase.
   */
  "add-feature": {
    name: "add-feature",
    description: "Add new functionality: patterns, types, extension points",
    contextDefaults: {
      topK: 7,
      structured: true,
      hybrid: true,
      alpha: 0.65,
      mmr: true,
      lambda: 0.55,     // more diversity — find related patterns, not just the closest match
      budget: 4000,
    },
    outputPrefix: [
      "## Skill: add-feature",
      "",
      "Before writing code:",
      "- Find the existing pattern that most closely matches the new feature",
      "- Check types and interfaces first — match existing shapes",
      "- Locate the natural extension point (factory, registry, config union…)",
      "",
      "Rules:",
      "- Follow existing code style exactly (naming, file layout, error handling)",
      "- No new abstractions unless the task explicitly requires one",
      "- Register the new feature everywhere the similar existing feature is registered",
    ].join("\n"),
    knowledgeCategoryBoost: ["pattern", "decision"],
  },

  /**
   * security — surface gotchas, validate inputs, check attack surfaces.
   *
   * Hybrid search with BM25 weight on security-relevant keywords.
   * Boosts "gotcha" knowledge entries which typically capture security issues.
   */
  security: {
    name: "security",
    description: "Security review: input validation, injection, auth, path traversal",
    contextDefaults: {
      topK: 6,
      hybrid: true,
      alpha: 0.55,      // BM25 better for security-relevant identifiers
      mmr: true,
      lambda: 0.6,
      budget: 3500,
    },
    outputPrefix: [
      "## Skill: security",
      "",
      "Check for:",
      "- Input validation at trust boundaries (user input, external APIs, env vars)",
      "- Injection vectors: SQL, shell, path, template, eval",
      "- Path traversal: relative paths, symlinks, root-escape",
      "- Authentication and authorisation gaps",
      "- Unsafe deserialisation or unvalidated JSON casts",
      "- Secrets in code, logs, or error messages",
      "- Dependency trust: dynamic require(), optional peer deps",
      "",
      "For each issue: severity (critical/high/medium/low), location, and fix.",
    ].join("\n"),
    knowledgeCategoryBoost: ["gotcha"],
  },

  /**
   * explain — understand purpose, design decisions, high-level flow.
   *
   * Higher MMR diversity to cover the breadth of a module,
   * lower budget since we want summaries not full code bodies.
   */
  explain: {
    name: "explain",
    description: "Explain code: purpose, design decisions, data flow",
    contextDefaults: {
      topK: 5,
      mmr: true,
      lambda: 0.4,      // diversity first — cover breadth, not just the top match
      budget: 2500,
    },
    outputPrefix: [
      "## Skill: explain",
      "",
      "Structure the explanation as:",
      "1. Purpose — what problem does this solve?",
      "2. Design decisions — why this structure / algorithm / abstraction?",
      "3. Data flow — how does data move through the key functions?",
      "4. Gotchas — non-obvious behaviour the caller must know",
      "",
      "Tailor depth to the question. Prefer analogies over jargon.",
    ].join("\n"),
    knowledgeCategoryBoost: ["glossary", "decision"],
  },

  /**
   * test — identify what to test, where to put tests, what to mock.
   *
   * Hybrid search to catch both test file patterns and source symbols.
   * Includes test files in results via higher topK.
   */
  test: {
    name: "test",
    description: "Write or improve tests: coverage gaps, mocks, test patterns",
    contextDefaults: {
      topK: 7,
      hybrid: true,
      alpha: 0.6,
      mmr: true,
      lambda: 0.6,
      budget: 3500,
    },
    outputPrefix: [
      "## Skill: test",
      "",
      "Identify:",
      "- What is the unit under test and its contract?",
      "- Happy path, edge cases, and error paths",
      "- External dependencies that need mocking (I/O, time, randomness)",
      "- Existing test file location pattern for this module",
      "",
      "Rules:",
      "- Tests should express intent, not implementation details",
      "- Prefer integration tests for I/O-heavy code; unit tests for pure logic",
      "- Each test should have a single, clearly named assertion focus",
    ].join("\n"),
    knowledgeCategoryBoost: ["pattern", "gotcha"],
  },
};

// ─── Public API ───────────────────────────────────────────────────────────────

/** Return a skill config by name, or undefined if not found. */
export function getSkill(name: string): SkillConfig | undefined {
  return SKILLS[name as SkillName];
}

/**
 * Merge skill defaults under user-supplied options.
 * User options always win; skill values fill in only what was not specified.
 */
export function applySkill(
  skill: SkillConfig,
  userOptions: Partial<ContextOptions>,
): Partial<ContextOptions> {
  return { ...skill.contextDefaults, ...userOptions };
}

/** Formatted list of all skills for --help output. */
export function listSkills(): string {
  return SKILL_NAMES.map((n) => `  ${n.padEnd(14)} ${SKILLS[n].description}`).join(
    "\n",
  );
}

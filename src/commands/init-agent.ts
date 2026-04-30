import chalk from "chalk";
import fs from "fs";
import path from "path";
import { loadConfig } from "../core/config";
import { computeImportedBy } from "../indexer/deps";
import { RepositoryStorage } from "../storage/repository";
import { SummaryStorage } from "../storage/summaries";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AgentTarget = "claude" | "copilot" | "cursor" | "windsurf" | "gemini";

export interface InitAgentOptions {
  agents?: AgentTarget[];
  force?: boolean;
  /** Write Claude Code hooks to .claude/settings.json (Claude target only). */
  hooks?: boolean;
}

// ─── Markers ──────────────────────────────────────────────────────────────────

export const MARKER_START = "<!-- vemora:generated:start -->";
export const MARKER_END = "<!-- vemora:generated:end -->";

// ─── Default instructions ─────────────────────────────────────────────────────

export const DEFAULT_INSTRUCTIONS = `## Response style

Reply terse. Drop articles, filler, pleasantries, preamble. Fragments ok. Preserve code, paths, symbol names, commands unchanged.

## Working with this codebase

- **Before reading any file**, check the Key Exports table to locate the symbol.
- **Before querying**, try \`vemora query\` first — open a file only if context is insufficient.
- **Before deep-diving a file or symbol**, use \`vemora focus\` — aggregates impl, deps, callers, tests, and knowledge in one call.
- **Before modifying a file**, check blast radius: \`vemora deps <file> --root . --reverse-depth 2\`.
- **Before renaming or changing the signature of a symbol**, check callers: \`vemora usages <SymbolName> --root .\` (add \`--callers-only\` for methods).
- **After changes**, run the build/test command before declaring done.
- **Scope discipline**: only change what was asked. No refactoring, comments, or improvements beyond the request.
- **Save non-obvious findings** with \`vemora remember\` — decisions, gotchas, patterns. Skip what's obvious from reading the code.

## Session setup

\`\`\`bash
vemora brief --root .          # start of session: project overview + knowledge entries
vemora index --root . --watch  # background terminal: live re-index on file save
vemora index --root . --no-embed  # or: re-index manually after significant changes
\`\`\`

## Quick reference

| Need | Command |
|---|---|
| Session start | \`brief --root .\` |
| Session start (task-specific) | \`brief --root . --skill debug\\|refactor\\|add-feature\\|security\\|explain\\|test\` |
| File or symbol deep-dive | \`focus <target> --root .\` |
| Deep-dive restricted to lines | \`focus <target> --root . --lines <start>-<end>\` |
| Single method deep-dive | \`focus <ClassName.methodName> --root .\` |
| Class with all method bodies | \`focus <ClassName> --root . --depth method\` |
| Concept / how-does-X question | \`context --root . --query "<question>"\` |
| Fix / refactor / add code | \`context --root . --query "<task>" --keyword\` |
| Debug an error (skill preset) | \`context --root . --query "<error>" --skill debug\` |
| Refactor safely (skill preset) | \`context --root . --query "<target>" --skill refactor\` |
| Add new feature (skill preset) | \`context --root . --query "<feature>" --skill add-feature\` |
| Scope to recent changes | \`context --root . --query "..." --since HEAD~5\` |
| Complex multi-step task | \`plan "<task>" --root . --confirm --synthesize\` |
| Reduce LLM output tokens | add \`--terse\` to \`plan\` or \`ask\` |
| LLM audit (security/bugs/perf) | \`audit --root . --type security,bugs\` |
| Zero-LLM static scan | \`triage --root . --type bugs,security\` |
| Find unused code | \`dead-code --root .\` |
| Output too long | add \`--budget 2000\` to any command |
| No embeddings / fast search | add \`--keyword\` to \`query\` or \`context\` |
| Who imports a file | \`deps <file> --root .\` |
| Blast radius of a change | \`deps <file> --root . --reverse-depth 3\` |
| Who uses a symbol | \`usages <SymbolName> --root .\` |
| Who calls a method | \`usages <Method> --root . --callers-only\` |
| Save a finding | \`remember "text" --root .\` |
| Replace a finding | \`remember "text" --supersedes <id> --root .\` |
| Edit a finding in-place | \`knowledge update <id> "text" --root .\` |
`;

// ─── Main command ─────────────────────────────────────────────────────────────

export async function runInitAgent(
  rootDir: string,
  options: InitAgentOptions = {},
): Promise<void> {
  const ALL_AGENTS: AgentTarget[] = ["claude", "copilot", "cursor", "windsurf", "gemini"];
  const targets = options.agents ?? ALL_AGENTS;
  const force = options.force ?? false;

  const config = loadConfig(rootDir);
  const repo = new RepositoryStorage(rootDir);
  const summaryStorage = new SummaryStorage(rootDir);

  // ── Load index data ──────────────────────────────────────────────────────────
  const symbols = repo.loadSymbols();
  const depGraph = repo.loadDeps();
  const fileSummaries = summaryStorage.hasFileSummaries()
    ? summaryStorage.loadFileSummaries()
    : {};
  const projectSummary = summaryStorage.loadProjectSummary();

  // ── Derived data ─────────────────────────────────────────────────────────────

  // Entry points: files that import others but are not imported by anyone.
  const importedByMap = computeImportedBy(depGraph);
  const entryPoints = Object.keys(depGraph)
    .filter((f) => !importedByMap.has(f) && depGraph[f].imports.length > 0)
    .slice(0, 10);

  // Key exports: exported symbols from source files only (exclude docs/, tests/).
  // Sort order: classes and functions first (most useful for lookup), constants last.
  const TYPE_PRIORITY: Record<string, number> = { class: 0, function: 1, interface: 2, type: 3 };
  const exportedSymbols = Object.entries(symbols)
    .filter(([, s]) => s.exported && s.file.startsWith("src/"))
    .sort((a, b) => {
      const pa = TYPE_PRIORITY[a[1].type] ?? 4;
      const pb = TYPE_PRIORITY[b[1].type] ?? 4;
      return pa !== pb ? pa - pb : a[0].localeCompare(b[0]);
    })
    .slice(0, 40);

  // npm scripts from package.json (build, test, dev commands).
  const npmScripts = detectNpmScripts(rootDir);

  // ── Build generated block ────────────────────────────────────────────────────
  const block = buildGeneratedBlock(
    config.projectName,
    projectSummary?.overview ?? null,
    npmScripts,
    entryPoints,
    fileSummaries,
    exportedSymbols,
  );

  // ── Process each target ──────────────────────────────────────────────────────
  for (const agent of targets) {
    writeAgentFile(agent, rootDir, config.projectName, block, force);
  }

  // ── Claude Code hooks ────────────────────────────────────────────────────────
  if (options.hooks && targets.includes("claude")) {
    writeClaudeHooks(rootDir, force);
  }

  if (!projectSummary) {
    console.log(
      chalk.gray("  Tip: run `vemora summarize` to add a project overview."),
    );
  }
}

// ─── Per-agent file writers ───────────────────────────────────────────────────

function writeAgentFile(
  agent: AgentTarget,
  rootDir: string,
  projectName: string,
  block: string,
  force: boolean,
): void {
  switch (agent) {
    case "claude":
      writeClaudeFile(rootDir, projectName, block, force);
      break;
    case "copilot":
      writeCopilotFile(rootDir, block, force);
      break;
    case "cursor":
      writeCursorFile(rootDir, block, force);
      break;
    case "windsurf":
      writeWindsurfFile(rootDir, block, force);
      break;
    case "gemini":
      writeGeminiFile(rootDir, projectName, block, force);
      break;
  }
}

const CLAUDE_EXTRA_INSTRUCTIONS = `
## Claude Code memory

Use Claude Code's persistent memory alongside \`vemora remember\`:
- Save user preferences, working style, and feedback that go beyond the codebase.
- At session end, persist non-obvious discoveries not already captured by \`vemora remember\`.
`;

function writeClaudeFile(
  rootDir: string,
  projectName: string,
  block: string,
  force: boolean,
): void {
  const outputPath = path.join(rootDir, "CLAUDE.md");
  const label = "Claude Code: CLAUDE.md";
  const fullInstructions = DEFAULT_INSTRUCTIONS + CLAUDE_EXTRA_INSTRUCTIONS;

  if (!fs.existsSync(outputPath)) {
    const content = `# ${projectName}\n\n${fullInstructions}\n\n${block}\n`;
    fs.writeFileSync(outputPath, content, "utf-8");
    console.log(chalk.green(`✓ ${label} created`));
  } else {
    const result = mergeOrOverwrite(
      outputPath,
      `# ${projectName}\n\n${fullInstructions}\n\n${block}\n`,
      block,
      force,
      label,
    );
    if (!result) return;
  }
}

function writeCopilotFile(
  rootDir: string,
  block: string,
  force: boolean,
): void {
  const outputPath = path.join(rootDir, ".github", "copilot-instructions.md");
  const label = "Copilot: .github/copilot-instructions.md";

  if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const content = `${DEFAULT_INSTRUCTIONS}\n\n${block}\n`;
    fs.writeFileSync(outputPath, content, "utf-8");
    console.log(chalk.green(`✓ ${label} created`));
  } else {
    mergeOrOverwrite(
      outputPath,
      `${DEFAULT_INSTRUCTIONS}\n\n${block}\n`,
      block,
      force,
      label,
    );
  }
}

function writeCursorFile(rootDir: string, block: string, force: boolean): void {
  const outputPath = path.join(rootDir, ".cursor", "rules", "vemora.mdc");
  const label = "Cursor: .cursor/rules/vemora.mdc";
  const frontmatter =
    "---\ndescription: vemora codebase context\nalwaysApply: true\n---";

  if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const content = `${frontmatter}\n\n${DEFAULT_INSTRUCTIONS}\n\n${block}\n`;
    fs.writeFileSync(outputPath, content, "utf-8");
    console.log(chalk.green(`✓ ${label} created`));
  } else {
    const existing = fs.readFileSync(outputPath, "utf-8");
    const startIdx = existing.indexOf(MARKER_START);
    const endIdx = existing.indexOf(MARKER_END);

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      // Preserve everything before markers (includes frontmatter)
      const before = existing.slice(0, startIdx);
      const after = existing.slice(endIdx + MARKER_END.length);
      fs.writeFileSync(outputPath, before + block + after, "utf-8");
      console.log(chalk.green(`✓ ${label} updated (merged)`));
    } else if (force) {
      const content = `${frontmatter}\n\n${DEFAULT_INSTRUCTIONS}\n\n${block}\n`;
      fs.writeFileSync(outputPath, content, "utf-8");
      console.log(chalk.green(`✓ ${label} overwritten`));
    } else {
      printNoMarkersWarning(label);
    }
  }
}

function writeGeminiFile(
  rootDir: string,
  projectName: string,
  block: string,
  force: boolean,
): void {
  const outputPath = path.join(rootDir, "GEMINI.md");
  const label = "Gemini: GEMINI.md";

  if (!fs.existsSync(outputPath)) {
    const content = `# ${projectName}\n\n${DEFAULT_INSTRUCTIONS}\n\n${block}\n`;
    fs.writeFileSync(outputPath, content, "utf-8");
    console.log(chalk.green(`✓ ${label} created`));
  } else {
    mergeOrOverwrite(
      outputPath,
      `# ${projectName}\n\n${DEFAULT_INSTRUCTIONS}\n\n${block}\n`,
      block,
      force,
      label,
    );
  }
}

function writeWindsurfFile(
  rootDir: string,
  block: string,
  force: boolean,
): void {
  const outputPath = path.join(rootDir, ".windsurfrules");
  const label = "Windsurf: .windsurfrules";

  if (!fs.existsSync(outputPath)) {
    const content = `${DEFAULT_INSTRUCTIONS}\n\n${block}\n`;
    fs.writeFileSync(outputPath, content, "utf-8");
    console.log(chalk.green(`✓ ${label} created`));
  } else {
    mergeOrOverwrite(
      outputPath,
      `${DEFAULT_INSTRUCTIONS}\n\n${block}\n`,
      block,
      force,
      label,
    );
  }
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Merge block into existing file between markers, or overwrite/warn.
 * Returns true if file was written, false if skipped.
 */
function mergeOrOverwrite(
  outputPath: string,
  newContent: string,
  block: string,
  force: boolean,
  label: string,
): boolean {
  const existing = fs.readFileSync(outputPath, "utf-8");
  const startIdx = existing.indexOf(MARKER_START);
  const endIdx = existing.indexOf(MARKER_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + MARKER_END.length);
    fs.writeFileSync(outputPath, before + block + after, "utf-8");
    console.log(chalk.green(`✓ ${label} updated (merged)`));
    return true;
  }

  if (force) {
    fs.writeFileSync(outputPath, newContent, "utf-8");
    console.log(chalk.green(`✓ ${label} overwritten`));
    return true;
  }

  printNoMarkersWarning(label);
  return false;
}

function printNoMarkersWarning(label: string): void {
  console.log(
    chalk.yellow(
      `${label} exists but has no vemora markers.\n` +
        "  • Run with --force to overwrite it entirely.\n" +
        "  • Or manually add the markers to enable future merges:\n" +
        `      ${MARKER_START}\n` +
        `      ${MARKER_END}`,
    ),
  );
}

// ─── Claude Code hooks ────────────────────────────────────────────────────────

/**
 * Writes (or merges) vemora hook entries into .claude/settings.json.
 *
 * Two hooks are registered:
 *   - PreCompact  — emergency knowledge save before Claude compacts the context
 *   - Stop        — brief reminder to run `vemora remember` after each session
 *
 * Existing hooks unrelated to vemora are preserved.
 */
function writeClaudeHooks(rootDir: string, force: boolean): void {
  const settingsPath = path.join(rootDir, ".claude", "settings.json");
  const label = "Claude Code hooks: .claude/settings.json";

  // The PreCompact hook pipes the most recent assistant message into
  // `vemora remember` so that any decision mentioned just before compaction
  // is persisted. We cap input to 1000 chars to stay within CLI limits.
  const vemoraHooks = {
    PreCompact: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command:
              "echo \"Pre-compact save: run 'vemora remember <decision> --root . --category decision' to preserve any key decision before context is compressed.\"",
          },
        ],
      },
    ],
  };

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    if (!force) {
      // Merge: add only the hooks that aren't already present
      try {
        existing = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      } catch {
        existing = {};
      }
      const existingHooks = (existing.hooks ?? {}) as Record<string, unknown>;
      // Only add PreCompact if not already set
      if (existingHooks.PreCompact) {
        console.log(chalk.yellow(`  ${label} — PreCompact hook already exists, skipping. Use --force to overwrite.`));
        return;
      }
      existing.hooks = { ...existingHooks, ...vemoraHooks };
    } else {
      try {
        existing = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      } catch {
        existing = {};
      }
      existing.hooks = {
        ...((existing.hooks ?? {}) as Record<string, unknown>),
        ...vemoraHooks,
      };
    }
  } else {
    existing = { hooks: vemoraHooks };
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const tmp = settingsPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2), "utf-8");
  fs.renameSync(tmp, settingsPath);
  console.log(chalk.green(`✓ ${label} updated`));
}

// ─── Block builder ────────────────────────────────────────────────────────────

export function buildGeneratedBlock(
  _projectName: string,
  projectOverview: string | null,
  npmScripts: Record<string, string>,
  entryPoints: string[],
  fileSummaries: Record<string, { summary: string }>,
  exportedSymbols: Array<[string, { type: string; file: string }]>,
): string {
  const lines: string[] = [];

  lines.push(MARKER_START);
  lines.push("");

  // Project overview
  lines.push("## Project Overview");
  lines.push("");
  lines.push(
    projectOverview ??
      "_(Run `vemora summarize` to generate an AI-written project overview.)_",
  );
  lines.push("");

  // Commands
  if (Object.keys(npmScripts).length > 0) {
    lines.push("## Commands");
    lines.push("");
    lines.push("```bash");
    for (const [name, cmd] of Object.entries(npmScripts)) {
      lines.push(`npm run ${name.padEnd(16)} # ${cmd}`);
    }
    lines.push("```");
    lines.push("");
  }

  // Entry points
  if (entryPoints.length > 0) {
    lines.push("## Entry Points");
    lines.push("");
    for (const ep of entryPoints) {
      const summary = fileSummaries[ep]?.summary;
      lines.push(summary ? `- \`${ep}\` — ${summary}` : `- \`${ep}\``);
    }
    lines.push("");
  }

  // Key exports table
  if (exportedSymbols.length > 0) {
    lines.push("## Key Exports");
    lines.push("");
    lines.push("| Symbol | Type | File |");
    lines.push("|---|---|---|");
    for (const [name, sym] of exportedSymbols) {
      lines.push(`| \`${name}\` | ${sym.type} | \`${sym.file}\` |`);
    }
    lines.push("");
  }

  lines.push(
    `_Generated by \`vemora init-agent\` — ${new Date().toISOString()}_`,
  );
  lines.push("");

  lines.push(MARKER_END);

  return lines.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Reads npm scripts from package.json in rootDir.
 * Returns an empty object if no package.json or no scripts field.
 */
export function detectNpmScripts(rootDir: string): Record<string, string> {
  try {
    const pkgPath = path.join(rootDir, "package.json");
    if (!fs.existsSync(pkgPath)) return {};
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

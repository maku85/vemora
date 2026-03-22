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
}

// ─── Markers ──────────────────────────────────────────────────────────────────

export const MARKER_START = "<!-- vemora:generated:start -->";
export const MARKER_END = "<!-- vemora:generated:end -->";

// ─── Default instructions ─────────────────────────────────────────────────────

export const DEFAULT_INSTRUCTIONS = `## Working with this codebase

- **Before reading any file**, check the Key Exports table below to locate the relevant symbol.
- **Before querying**, try \`vemora query\` first — open a file only if the returned context is insufficient.
- **Before modifying a file**, check its blast radius: \`vemora deps <file> --root . --reverse-depth 2\`.
- **Before renaming a symbol or changing its API**, check who uses it: \`vemora usages <SymbolName> --root .\`.
- **After making changes**, always run the build/test command to verify correctness before declaring done.
- **Scope discipline**: only make changes directly requested. Do not refactor surrounding code, add comments, or improve things that were not explicitly asked.
- **Save non-obvious findings** with \`vemora remember\` when you discover a gotcha, an architectural decision, or a pattern worth preserving for future sessions. Do not save things already obvious from reading the code.

## Session setup

For a live index, run this in a background terminal at the start of your session:

\`\`\`bash
vemora index --root . --watch
\`\`\`

Without it, re-index manually after significant changes:

\`\`\`bash
vemora index --root . --no-embed
\`\`\`

## Session memory

At the **start of each session**, recall saved project knowledge:

\`\`\`bash
vemora knowledge list --root .
\`\`\`

During the session, **proactively save** anything non-obvious that future sessions would benefit from knowing:

\`\`\`bash
vemora remember "text" --root . --category decision   # architectural choice and why
vemora remember "text" --root . --category gotcha     # surprising behaviour or constraint
vemora remember "text" --root . --category pattern    # approved implementation pattern
\`\`\`

**Save:** why a design decision was made, a non-obvious constraint, a bug and its root cause, an approved pattern.
**Do not save:** things obvious from reading the code, file structure, recent changes (use \`git log\`), or anything already in the index.

## Quick reference

Use this decision tree to choose the right command:

| Situation | Command |
|---|---|
| User asks about a function, class, or file | \`context --root . --file <path>\` |
| User asks a concept/how-does-X-work question | \`context --root . --query "<question>"\` |
| User asks to fix / refactor / add code | \`context --root . --query "<task>" --keyword\`, then check for \`*.test.ts\` before editing |
| Output is too long for your context window | add \`--budget 2000\` (or lower) to any command |
| No embeddings available / fast keyword search | add \`--keyword\` to any \`query\` or \`context\` call |
| Need to understand who imports a file | \`deps <file> --root .\` |
| Need to see the full blast radius of a change | \`deps <file> --root . --reverse-depth 3\` |
| Need to find who calls a specific symbol | \`usages <SymbolName> --root .\` |`;

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
  const exportedSymbols = Object.entries(symbols)
    .filter(([, s]) => s.exported && s.file.startsWith("src/"))
    .sort(
      (a, b) => a[1].type.localeCompare(b[1].type) || a[0].localeCompare(b[0]),
    )
    .slice(0, 60);

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

In addition to \`vemora remember\`, Claude Code has its own persistent memory system.
Use it to save user preferences, feedback, and context that goes beyond the codebase itself:

- Save user preferences, working style, and feedback that should persist across sessions.
- At session end, write any non-obvious discoveries or decisions that aren't already captured by \`vemora remember\`.
- Read memory at session start to re-establish context without asking the user to repeat themselves.
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

  // vemora usage instructions
  lines.push("## Codebase Search (vemora)");
  lines.push("");
  lines.push(
    "This project is indexed with `vemora`. Before working on unfamiliar code, use it to retrieve only the relevant context:",
  );
  lines.push("");
  lines.push("```bash");
  lines.push("# Semantic search — returns the most relevant code chunks");
  lines.push('vemora query "your question" --root .');
  lines.push("");
  lines.push("# One-shot answer: retrieve context and call the configured LLM");
  lines.push('vemora ask "your question" --root .');
  lines.push(
    'vemora ask "your question" --root . --keyword  # no embeddings needed',
  );
  lines.push("");
  lines.push("# Generate a full context block to paste into any LLM");
  lines.push(
    'vemora context --root . --query "your question" > context.md',
  );
  lines.push("");
  lines.push("# Include a specific file with its dependency graph");
  lines.push(
    "vemora context --root . --file src/path/to/file.ts",
  );
  lines.push("");
  lines.push("# Limit context to a token budget");
  lines.push(
    'vemora query "your question" --root . --budget 3000',
  );
  lines.push("");
  lines.push(
    "# Save a persistent note (architectural decision, gotcha, approved pattern)",
  );
  lines.push(
    'vemora remember "text" --root . --category decision',
  );
  lines.push(
    'vemora remember "text" --root . --category gotcha',
  );
  lines.push("");
  lines.push("# List saved knowledge entries");
  lines.push("vemora knowledge list --root .");
  lines.push("");
  lines.push("# Find all callers of a symbol (follows re-export chains)");
  lines.push("vemora usages <SymbolName> --root .");
  lines.push("```");
  lines.push("");
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

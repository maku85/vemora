import chalk from "chalk";
import { loadConfig } from "../core/config";
import { computeImportedBy } from "../indexer/deps";
import { RepositoryStorage } from "../storage/repository";
import type { CallGraph, DependencyGraph, SymbolIndex } from "../core/types";

// ─── Public types ─────────────────────────────────────────────────────────────

export type DeadCodeType = "uncalled-private" | "unused-export" | "unreachable-file";

export interface DeadCodeOptions {
  types?: DeadCodeType[];
  output?: "terminal" | "json";
}

export interface DeadCodeFinding {
  type: DeadCodeType;
  file: string;
  line: number;
  symbol?: string;
  symbolType?: string;
  reason: string;
}

// ─── Detectors ────────────────────────────────────────────────────────────────

/**
 * Private functions and methods that appear in the call graph as a callee
 * but have no recorded callers (calledBy is empty).
 *
 * Only flags symbols with an explicit call graph entry — symbols missing from
 * the call graph entirely are excluded because coverage may be incomplete
 * (e.g. arrow functions assigned to variables are not always tracked).
 */
function findUncalledPrivate(
  symbols: SymbolIndex,
  callGraph: CallGraph,
): DeadCodeFinding[] {
  const findings: DeadCodeFinding[] = [];

  for (const [name, entry] of Object.entries(symbols)) {
    if (entry.exported) continue;
    if (entry.type !== "function" && entry.type !== "method") continue;

    // Constructors are called implicitly via `new` — skip.
    const shortName = name.includes(".") ? name.split(".").pop()! : name;
    if (shortName === "constructor") continue;

    // Methods are stored in the call graph as "file:methodName" (no class prefix).
    const cgKey = `${entry.file}:${shortName}`;
    const cgEntry = callGraph[cgKey];

    if (cgEntry && cgEntry.calledBy.length === 0) {
      findings.push({
        type: "uncalled-private",
        file: entry.file,
        line: entry.startLine,
        symbol: name,
        symbolType: entry.type,
        reason: `Private ${entry.type} appears in the call graph but has no recorded callers`,
      });
    }
  }

  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * Exported symbols not imported by any file in the dep graph.
 *
 * Caveats:
 * - Files imported via namespace (`import * as X`) are assumed to use all
 *   exports and are excluded from flagging.
 * - Side-effect imports (`import './file'`) are treated the same as namespace.
 * - This does not detect usage via dynamic `require()` or string-based lookups.
 */
function findUnusedExports(
  symbols: SymbolIndex,
  depGraph: DependencyGraph,
): DeadCodeFinding[] {
  // Build: file -> set of named symbols imported from it
  const importedSymbols = new Map<string, Set<string>>();
  // Files imported as namespace (import * as X) or side-effect — assume all symbols used
  const namespaceImported = new Set<string>();

  for (const fileDeps of Object.values(depGraph)) {
    for (const imp of fileDeps.imports) {
      if (imp.symbols.length === 0) {
        namespaceImported.add(imp.file);
      } else {
        const set = importedSymbols.get(imp.file) ?? new Set<string>();
        for (const s of imp.symbols) set.add(s);
        importedSymbols.set(imp.file, set);
      }
    }
  }

  const findings: DeadCodeFinding[] = [];

  for (const [name, entry] of Object.entries(symbols)) {
    if (!entry.exported) continue;
    // Skip interface/type — they are erased at runtime; dep graph may not track them.
    if (entry.type === "interface" || entry.type === "type") continue;
    if (namespaceImported.has(entry.file)) continue;

    const usedNames = importedSymbols.get(entry.file) ?? new Set<string>();
    const isUsed =
      usedNames.has(name) || (entry.isDefault === true && usedNames.has("default"));

    if (!isUsed) {
      findings.push({
        type: "unused-export",
        file: entry.file,
        line: entry.startLine,
        symbol: name,
        symbolType: entry.type,
        reason: `Exported ${entry.type} not imported by any file in the project`,
      });
    }
  }

  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * Files that export symbols but are never imported by any other file.
 *
 * Entry points (cli.ts, index.ts, main.ts, server.ts, app.ts) are excluded —
 * they are intentionally top-level and not imported by others.
 */
const ENTRY_POINT_NAMES = new Set([
  "cli.ts", "index.ts", "main.ts", "server.ts", "app.ts",
  "cli.js", "index.js", "main.js", "server.js", "app.js",
]);

function findUnreachableFiles(
  symbols: SymbolIndex,
  depGraph: DependencyGraph,
): DeadCodeFinding[] {
  const importedByMap = computeImportedBy(depGraph);

  // Files that have at least one exported symbol (intended to be imported)
  const filesWithExports = new Set(
    Object.values(symbols)
      .filter((e) => e.exported)
      .map((e) => e.file),
  );

  const findings: DeadCodeFinding[] = [];

  for (const file of Object.keys(depGraph)) {
    if (importedByMap.has(file)) continue;
    if (!filesWithExports.has(file)) continue;

    const basename = file.split("/").pop() ?? file;
    if (ENTRY_POINT_NAMES.has(basename)) continue;

    findings.push({
      type: "unreachable-file",
      file,
      line: 1,
      reason: "File exports symbols but is never imported by any other file in the project",
    });
  }

  return findings.sort((a, b) => a.file.localeCompare(b.file));
}

// ─── Formatters ───────────────────────────────────────────────────────────────

const TYPE_LABEL: Record<DeadCodeType, string> = {
  "uncalled-private": "UNCALLED PRIVATE",
  "unused-export": "UNUSED EXPORT",
  "unreachable-file": "UNREACHABLE FILE",
};

function formatTerminal(
  findingsByType: Map<DeadCodeType, DeadCodeFinding[]>,
  types: DeadCodeType[],
): void {
  const total = [...findingsByType.values()].reduce((n, f) => n + f.length, 0);

  console.log(chalk.bold.cyan("\n── vemora dead-code ─────────────────────────────────────────"));

  const summary = types
    .map((t) => {
      const count = findingsByType.get(t)?.length ?? 0;
      return `${chalk.bold(count)} ${t}`;
    })
    .join("  ·  ");
  console.log(chalk.gray(`   ${summary}\n`));

  if (total === 0) {
    console.log(chalk.green("  No dead code found.\n"));
    return;
  }

  for (const type of types) {
    const findings = findingsByType.get(type) ?? [];
    if (findings.length === 0) continue;

    console.log(chalk.bold.white(TYPE_LABEL[type]));

    for (const f of findings) {
      const loc = `${chalk.blue(f.file)}:${chalk.cyan(String(f.line))}`;
      const badge = f.symbolType ? chalk.gray(` [${f.symbolType}]`) : "";
      const sym = f.symbol ? `  ${chalk.yellow(f.symbol)}` : "";
      console.log(`  ${loc}${badge}${sym}`);
      console.log(`  ${chalk.gray(f.reason)}`);
    }
    console.log();
  }

  console.log(
    chalk.gray(
      "Note: call graph coverage is incomplete for dynamic dispatch and arrow function variables.",
    ),
  );
}

function formatJson(findingsByType: Map<DeadCodeType, DeadCodeFinding[]>): void {
  const all: DeadCodeFinding[] = [...findingsByType.values()].flat();
  console.log(JSON.stringify(all, null, 2));
}

// ─── Main command ─────────────────────────────────────────────────────────────

export async function runDeadCode(
  rootDir: string,
  options: DeadCodeOptions = {},
): Promise<void> {
  loadConfig(rootDir);

  const repo = new RepositoryStorage(rootDir);
  const symbols = repo.loadSymbols();
  const callGraph = repo.loadCallGraph();
  const depGraph = repo.loadDeps();

  if (Object.keys(symbols).length === 0) {
    console.error(chalk.red("No index found. Run `vemora index` first."));
    process.exit(1);
  }

  const types: DeadCodeType[] = options.types ?? [
    "uncalled-private",
    "unused-export",
    "unreachable-file",
  ];

  const findingsByType = new Map<DeadCodeType, DeadCodeFinding[]>();

  if (types.includes("uncalled-private")) {
    findingsByType.set("uncalled-private", findUncalledPrivate(symbols, callGraph));
  }
  if (types.includes("unused-export")) {
    findingsByType.set("unused-export", findUnusedExports(symbols, depGraph));
  }
  if (types.includes("unreachable-file")) {
    findingsByType.set("unreachable-file", findUnreachableFiles(symbols, depGraph));
  }

  const fmt = options.output ?? "terminal";
  if (fmt === "json") {
    formatJson(findingsByType);
  } else {
    formatTerminal(findingsByType, types);
  }
}

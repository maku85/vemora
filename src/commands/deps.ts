import chalk from "chalk";
import { loadConfig } from "../core/config";
import { computeImportedBy, getTransitiveDeps, getTransitiveImportedBy } from "../indexer/deps";
import { RepositoryStorage } from "../storage/repository";

export interface DepsOptions {
  /** Show files that import the target (reverse direction) */
  usedBy?: boolean;
  /** Recursion depth for outgoing imports (default: 1) */
  depth?: number;
  /** Recursion depth for incoming importers (default: 1) */
  reverseDepth?: number;
}

/**
 * vemora deps <file>
 *
 * Shows the dependency context for a specific file:
 *   - What it imports (direct + optionally transitive)
 *   - What imports it (reverse edges)
 *
 * This is useful when you want to understand the blast radius of a change
 * or find all the files an LLM needs to understand a given module.
 */
export async function runDeps(
  rootDir: string,
  targetFile: string,
  options: DepsOptions = {},
): Promise<void> {
  const config = loadConfig(rootDir);
  const repo = new RepositoryStorage(rootDir);
  const depGraph = repo.loadDeps();
  const _meta = repo.loadMetadata();

  // Normalize separators — user might type with backslash on Windows
  const file = targetFile.replace(/\\/g, "/");

  if (
    !depGraph[file] &&
    !Object.values(depGraph).some((d) => d.imports.some((i) => i.file === file))
  ) {
    console.log(chalk.yellow(`No dependency data for: ${file}`));
    console.log(
      chalk.gray("Make sure the file is indexed and is a JS/TS file."),
    );
    return;
  }

  const depth = options.depth ?? 1;
  const reverseDepth = options.reverseDepth ?? 1;
  const importedByMap = computeImportedBy(depGraph);

  // ── Header ────────────────────────────────────────────────────────────────
  console.log();
  console.log(chalk.bold(`Dependency context for:`));
  console.log(chalk.cyan(`  ${file}`));
  console.log();

  // ── Outgoing: what this file imports ─────────────────────────────────────
  const fileDeps = depGraph[file];
  if (fileDeps?.imports.length) {
    if (depth <= 1) {
      console.log(chalk.bold(`Imports (${fileDeps.imports.length}):`));
      for (const imp of fileDeps.imports) {
        const syms = formatSymbols(imp.symbols);
        console.log(`  ${chalk.gray("←")} ${chalk.blue(imp.file)}${syms}`);
      }
    } else {
      // Transitive deps
      const transitive = getTransitiveDeps(file, depGraph, depth);
      console.log(
        chalk.bold(
          `Imports — transitive up to depth ${depth} (${transitive.size} files):`,
        ),
      );

      // Group by distance
      const byDist = new Map<number, string[]>();
      for (const [f, dist] of transitive) {
        const list = byDist.get(dist) ?? [];
        list.push(f);
        byDist.set(dist, list);
      }
      for (const [dist, files] of [...byDist.entries()].sort(
        (a, b) => a[0] - b[0],
      )) {
        console.log(chalk.gray(`  depth ${dist}:`));
        for (const f of files) {
          const directImp = fileDeps.imports.find((i) => i.file === f);
          const syms = directImp ? formatSymbols(directImp.symbols) : "";
          console.log(`    ${chalk.gray("←")} ${chalk.blue(f)}${syms}`);
        }
      }
    }
    console.log();
  } else {
    console.log(
      chalk.gray(
        "No outgoing imports (not a JS/TS file, or no relative imports found).",
      ),
    );
    console.log();
  }

  // ── Incoming: what imports this file ─────────────────────────────────────
  const directCallers = importedByMap.get(file) ?? [];
  if (directCallers.length === 0) {
    console.log(chalk.gray("Not imported by any other file in the index."));
    console.log();
  } else if (reverseDepth <= 1) {
    console.log(chalk.bold(`Used by (${directCallers.length}):`));
    for (const caller of directCallers) {
      const entry = depGraph[caller]?.imports.find((i) => i.file === file);
      const syms = entry ? formatSymbols(entry.symbols) : "";
      console.log(`  ${chalk.gray("→")} ${chalk.blue(caller)}${syms}`);
    }
    console.log();
  } else {
    // Transitive reverse deps
    const transitive = getTransitiveImportedBy(file, importedByMap, reverseDepth);
    console.log(
      chalk.bold(
        `Used by — transitive up to depth ${reverseDepth} (${transitive.size} files):`,
      ),
    );

    // Group by distance
    const byDist = new Map<number, string[]>();
    for (const [f, dist] of transitive) {
      const list = byDist.get(dist) ?? [];
      list.push(f);
      byDist.set(dist, list);
    }
    for (const [dist, files] of [...byDist.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      console.log(chalk.gray(`  depth ${dist}:`));
      for (const f of files) {
        // For depth-1 files we can show symbols; deeper ones are indirect
        const entry =
          dist === 1
            ? depGraph[f]?.imports.find((i) => i.file === file)
            : undefined;
        const syms = entry ? formatSymbols(entry.symbols) : "";
        console.log(`    ${chalk.gray("→")} ${chalk.blue(f)}${syms}`);
      }
    }
    console.log();
  }

  // ── LLM context hint ─────────────────────────────────────────────────────
  const contextFiles = new Set<string>([
    file,
    ...(fileDeps?.imports.map((i) => i.file) ?? []),
    ...directCallers,
  ]);
  console.log(
    chalk.bold(`Suggested context for LLM (${contextFiles.size} files):`),
  );
  for (const f of contextFiles) {
    console.log(`  ${chalk.cyan(f)}`);
  }
  console.log();
  console.log(
    chalk.gray(`Project: ${config.projectName} (${config.projectId})`),
  );
}

function formatSymbols(symbols: string[]): string {
  if (symbols.length === 0) return "";
  const shown = symbols.slice(0, 5);
  const rest = symbols.length - shown.length;
  const suffix = rest > 0 ? `, +${rest}` : "";
  return chalk.gray(` {${shown.join(", ")}${suffix}}`);
}

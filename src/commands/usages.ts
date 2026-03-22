import chalk from "chalk";

import { loadConfig } from "../core/config";
import { RepositoryStorage } from "../storage/repository";

export interface UsagesOptions {
  /** Max re-export chain depth to follow (default: 10) */
  depth?: number;
  /** Show only files that actually call the symbol (require call graph data) */
  callersOnly?: boolean;
}

interface ImportChainNode {
  /** File that imports the symbol */
  file: string;
  /** The file it imported FROM (defFile for direct, re-exporter for transitive) */
  from: string;
  /** Hop count from the definition file */
  depth: number;
}

/**
 * vemora usages <SymbolName>
 *
 * Finds all files that use a named symbol, following re-export chains.
 * Uses both the dependency graph (reliable) and the call graph (line-level detail).
 */
export async function runUsages(
  rootDir: string,
  symbolName: string,
  options: UsagesOptions = {},
): Promise<void> {
  const config = loadConfig(rootDir);
  const repo = new RepositoryStorage(rootDir);
  const symbols = repo.loadSymbols();
  const depGraph = repo.loadDeps();
  const callGraph = repo.loadCallGraph();

  // ── 1. Resolve symbol ────────────────────────────────────────────────────────

  let resolvedName = symbolName;
  if (!symbols[resolvedName]) {
    const lower = symbolName.toLowerCase();
    const candidates = Object.keys(symbols).filter(
      (s) => s.toLowerCase() === lower,
    );
    if (candidates.length === 0) {
      console.log(chalk.yellow(`Symbol "${symbolName}" not found in index.`));
      console.log(
        chalk.gray("Run `vemora index --root .` to update the index."),
      );
      return;
    }
    if (candidates.length === 1) {
      resolvedName = candidates[0];
    } else {
      console.log(
        chalk.yellow(`Ambiguous symbol name. Did you mean one of these?`),
      );
      for (const c of candidates) {
        console.log(`  ${chalk.cyan(c)}  ${chalk.gray(`(${symbols[c].file})`)}`);
      }
      return;
    }
  }

  const entry = symbols[resolvedName];
  const defFile = entry.file;
  const maxDepth = options.depth ?? 10;

  console.log();
  console.log(chalk.bold(`Usages of ${chalk.cyan(resolvedName)}`));
  console.log(
    `  Defined in ${chalk.blue(defFile)}:${entry.startLine}  ${chalk.gray(`(${entry.type})`)}`,
  );
  console.log();

  // ── Methods: call graph only ─────────────────────────────────────────────────
  //
  // Methods are not individually imported — the dep graph tracks the containing
  // class import, not individual method calls. Use the call graph exclusively.
  // The call graph stores methods as "file:methodName" (without class prefix).

  if (entry.type === "method") {
    const methodName = resolvedName.includes(".")
      ? resolvedName.split(".").pop()!
      : resolvedName;
    const cgKey = `${defFile}:${methodName}`;
    const cgEntry = callGraph[cgKey];
    const calledBy = cgEntry?.calledBy ?? [];

    if (calledBy.length === 0) {
      console.log(chalk.gray("No call graph data for this method."));
      console.log(
        chalk.gray(
          `  Methods are not tracked via imports — only the call graph can find callers.`,
        ),
      );
      if (entry.parent) {
        console.log(
          chalk.gray(
            `  Tip: try \`vemora usages ${entry.parent}\` to find all files that import the class.`,
          ),
        );
      }
      console.log(
        chalk.gray(
          "  Re-index with tree-sitter enabled to populate call graph data.",
        ),
      );
    } else {
      // Group calledBy entries by file
      const byFile = new Map<string, string[]>();
      for (const callerScope of calledBy) {
        const colonIdx = callerScope.lastIndexOf(":");
        if (colonIdx === -1) continue;
        const callerFile = callerScope.substring(0, colonIdx);
        const callerFn = callerScope.substring(colonIdx + 1);
        const list = byFile.get(callerFile) ?? [];
        if (!list.includes(callerFn)) list.push(callerFn);
        byFile.set(callerFile, list);
      }

      console.log(
        chalk.bold(`Found in ${byFile.size} file${byFile.size !== 1 ? "s" : ""} (via call graph):`),
      );
      console.log();
      for (const [file, fns] of byFile) {
        const callInfo = chalk.gray(`  (called in: ${fns.join(", ")})`);
        console.log(`  ${chalk.gray("→")} ${chalk.blue(file)}${callInfo}`);
      }
      console.log();
      console.log(chalk.yellow("⚠ Call graph coverage may be incomplete (arrow functions, injected dependencies)."));
    }
    console.log(chalk.gray(`Project: ${config.projectName} (${config.projectId})`));
    return;
  }

  // ── 2. BFS over dep graph to find all importers (following re-exports) ───────

  const visited = new Set<string>(); // importer files already enqueued
  const queue: ImportChainNode[] = [];
  const allImporters: ImportChainNode[] = [];

  // Whether the symbol is a default export — also match the "default" sentinel
  const isDefaultExport = entry.isDefault === true;

  // Seed: direct importers of the definition file
  for (const [importerFile, fileDeps] of Object.entries(depGraph)) {
    for (const imp of fileDeps.imports) {
      if (
        imp.file === defFile &&
        (imp.symbols.includes(resolvedName) ||
          (isDefaultExport && imp.symbols.includes("default")))
      ) {
        if (!visited.has(importerFile)) {
          visited.add(importerFile);
          const node: ImportChainNode = { file: importerFile, from: defFile, depth: 1 };
          queue.push(node);
          allImporters.push(node);
        }
      }
    }
  }

  // BFS: follow re-export chains
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    for (const [importerFile, fileDeps] of Object.entries(depGraph)) {
      for (const imp of fileDeps.imports) {
        if (
          imp.file === current.file &&
          (imp.symbols.includes(resolvedName) ||
            (isDefaultExport && imp.symbols.includes("default")))
        ) {
          if (!visited.has(importerFile)) {
            visited.add(importerFile);
            const node: ImportChainNode = {
              file: importerFile,
              from: current.file,
              depth: current.depth + 1,
            };
            queue.push(node);
            allImporters.push(node);
          }
        }
      }
    }
  }

  // ── 3. Identify re-exporters ─────────────────────────────────────────────────
  //
  // A file is a re-exporter if other files import the symbol FROM it
  // (and it is not the definition file itself).

  const reExporterFiles = new Set(
    allImporters.filter((n) => n.from !== defFile).map((n) => n.from),
  );

  // ── 4. Build call-site map from the call graph ───────────────────────────────
  //
  // Keys in the call graph: "<file>:<symbolName>"
  // We look up the definition file AND all re-exporters, because the call graph
  // resolves calls to wherever the symbol was imported FROM.

  const aliasKeys = new Set<string>([`${defFile}:${resolvedName}`]);
  for (const reExp of reExporterFiles) {
    aliasKeys.add(`${reExp}:${resolvedName}`);
  }

  // callerFile -> list of calling scope names (function / method)
  const callSitesByFile = new Map<string, string[]>();

  for (const aliasKey of aliasKeys) {
    const cgEntry = callGraph[aliasKey];
    if (!cgEntry?.calledBy?.length) continue;

    for (const callerScope of cgEntry.calledBy) {
      // callerScope = "relative/path/to/file.ts:functionName"
      const colonIdx = callerScope.lastIndexOf(":");
      if (colonIdx === -1) continue;
      const callerFile = callerScope.substring(0, colonIdx);
      const callerFn = callerScope.substring(colonIdx + 1);

      const list = callSitesByFile.get(callerFile) ?? [];
      if (!list.includes(callerFn)) list.push(callerFn);
      callSitesByFile.set(callerFile, list);
    }
  }

  // ── 5. Filter if --callers-only ──────────────────────────────────────────────

  const importersToShow = options.callersOnly
    ? allImporters.filter((n) => callSitesByFile.has(n.file))
    : allImporters;

  if (importersToShow.length === 0) {
    if (options.callersOnly) {
      console.log(
        chalk.gray(
          "No call graph data found. Try without --callers-only, or re-index with tree-sitter.",
        ),
      );
    } else {
      console.log(chalk.gray("No files import this symbol."));
    }
    return;
  }

  // ── 6. Print results ─────────────────────────────────────────────────────────

  const total = importersToShow.length;
  console.log(
    chalk.bold(
      `Found ${total} file${total !== 1 ? "s" : ""} that use this symbol:`,
    ),
  );
  console.log();

  const directImporters = importersToShow.filter((n) => n.from === defFile);
  const transitiveImporters = importersToShow.filter((n) => n.from !== defFile);

  if (directImporters.length > 0) {
    console.log(chalk.bold(`Direct imports  (from ${chalk.blue(defFile)}):`));
    for (const node of directImporters) {
      printImporterLine(node.file, reExporterFiles, callSitesByFile);
    }
    console.log();
  }

  if (transitiveImporters.length > 0) {
    // Group by re-exporter
    const byReExporter = new Map<string, ImportChainNode[]>();
    for (const node of transitiveImporters) {
      const list = byReExporter.get(node.from) ?? [];
      list.push(node);
      byReExporter.set(node.from, list);
    }

    console.log(chalk.bold("Via re-exports:"));
    for (const [reExp, nodes] of byReExporter) {
      console.log(`  ${chalk.yellow("↗")} ${chalk.blue(reExp)}`);
      for (const node of nodes) {
        printImporterLine(
          node.file,
          reExporterFiles,
          callSitesByFile,
          "    ",
        );
      }
    }
    console.log();
  }

  // ── 7. Footer ────────────────────────────────────────────────────────────────

  const withCallSites = callSitesByFile.size;
  if (withCallSites > 0) {
    console.log(
      chalk.gray(
        `Call graph: ${withCallSites} of ${total} file${total !== 1 ? "s" : ""} have call-site detail.`,
      ),
    );
  } else {
    console.log(
      chalk.gray(
        "No call graph data. Re-index with tree-sitter for call-site details.",
      ),
    );
  }
  console.log(chalk.gray(`Project: ${config.projectName} (${config.projectId})`));
}

function printImporterLine(
  file: string,
  reExporterFiles: Set<string>,
  callSitesByFile: Map<string, string[]>,
  indent = "  ",
): void {
  const isReExp = reExporterFiles.has(file);
  const badge = isReExp ? chalk.yellow(" [re-exports]") : "";
  const sites = callSitesByFile.get(file);
  const callInfo =
    sites?.length
      ? chalk.gray(`  (called in: ${sites.join(", ")})`)
      : "";
  console.log(`${indent}${chalk.gray("→")} ${chalk.blue(file)}${badge}${callInfo}`);
}

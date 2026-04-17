import chalk from "chalk";
import path from "path";
import { loadConfig } from "../core/config";
import type {
  CallGraph,
  Chunk,
  DependencyGraph,
  FileIndex,
  FileSummaryIndex,
  KnowledgeEntry,
  SymbolIndex,
} from "../core/types";
import { computeImportedBy } from "../indexer/deps";
import { findTestFiles } from "../indexer/tests";
import { KnowledgeStorage } from "../storage/knowledge";
import { RepositoryStorage } from "../storage/repository";
import { SummaryStorage } from "../storage/summaries";
import { truncateToTokenBudget } from "../utils/tokenizer";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface FocusOptions {
  /** Output format (default: markdown — best for LLM consumption) */
  format?: "markdown" | "plain";
  /** Max tokens to include in output. Output is truncated if exceeded. */
  budget?: number;
  /** Restrict implementation output to chunks overlapping this line range (e.g. "200-280") */
  lines?: { start: number; end: number };
  /** Depth of expansion for class targets: "method" expands each member's implementation */
  depth?: "method";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** True when target looks like a file path rather than a symbol name */
function looksLikeFilePath(target: string): boolean {
  return target.includes("/") || target.includes("\\") || /\.\w{2,4}$/.test(target);
}

/** Resolve a user-supplied target to an exact key in the file index */
function resolveFile(target: string, fileIndex: FileIndex): string | null {
  if (target in fileIndex) return target;
  // Match by path suffix (e.g. "cache.ts" → "src/storage/cache.ts")
  const candidates = Object.keys(fileIndex).filter(
    (f) => f === target || f.endsWith(`/${target}`) || path.basename(f) === target || f.includes(target),
  );
  if (candidates.length === 0) return null;
  // Prefer the shortest match (most specific)
  return candidates.sort((a, b) => a.length - b.length)[0];
}

/** Resolve a user-supplied target to an exact key in the symbol index */
function resolveSymbol(target: string, symbols: SymbolIndex): string | null {
  if (target in symbols) return target;
  const lower = target.toLowerCase();
  return Object.keys(symbols).find((s) => s.toLowerCase() === lower) ?? null;
}

/** Knowledge entries related to a file or symbol */
function relatedKnowledge(
  entries: KnowledgeEntry[],
  filePath: string | null,
  symbolName: string | null,
): KnowledgeEntry[] {
  return entries.filter((e) => {
    if (filePath) {
      if (e.relatedFiles?.some((f) => f === filePath)) return true;
      const text = `${e.title} ${e.body}`.toLowerCase();
      if (text.includes(path.basename(filePath, path.extname(filePath)).toLowerCase())) return true;
    }
    if (symbolName) {
      if (e.relatedSymbols?.some((s) => s === symbolName)) return true;
      const text = `${e.title} ${e.body}`.toLowerCase();
      if (text.includes(symbolName.toLowerCase())) return true;
    }
    return false;
  });
}

// ─── Section builder ──────────────────────────────────────────────────────────

function section(title: string, format: "markdown" | "plain"): string {
  return format === "markdown" ? `\n## ${title}\n` : `\n=== ${title} ===\n`;
}

function codeBlock(label: string, content: string, format: "markdown" | "plain"): string {
  if (format === "markdown") return `\`\`\`\n// ${label}\n${content}\n\`\`\`\n`;
  return `// ${label}\n${content}\n`;
}

// ─── File focus ───────────────────────────────────────────────────────────────

function buildFileFocus(
  filePath: string,
  chunks: Chunk[],
  symbols: SymbolIndex,
  depGraph: DependencyGraph,
  callGraph: CallGraph,
  fileSummaries: FileSummaryIndex,
  knowledge: KnowledgeEntry[],
  fileIndex: FileIndex,
  format: "markdown" | "plain",
  lines?: { start: number; end: number },
): string {
  const parts: string[] = [];
  const md = format === "markdown";

  parts.push(md ? `# Focus: \`${filePath}\`\n` : `=== Focus: ${filePath} ===\n`);

  // ── Summary ────────────────────────────────────────────────────────────────
  const summary = fileSummaries[filePath]?.summary;
  if (summary) {
    parts.push(section("Summary", format));
    parts.push(summary);
  }

  // ── Exported symbols ───────────────────────────────────────────────────────
  const exported = Object.entries(symbols)
    .filter(([, e]) => e.file === filePath && e.exported)
    .sort(([, a], [, b]) => a.startLine - b.startLine);

  if (exported.length > 0) {
    parts.push(section("Exported Symbols", format));
    for (const [name, e] of exported) {
      const parent = e.parent ? ` (in ${e.parent})` : "";
      parts.push(md ? `- \`${name}\` — ${e.type}${parent}, line ${e.startLine}` : `- ${name} (${e.type}${parent}, line ${e.startLine})`);
    }
  }

  // ── Implementation ─────────────────────────────────────────────────────────
  const fileChunks = chunks
    .filter((c) => c.file === filePath && (!lines || (c.end >= lines.start && c.start <= lines.end)))
    .sort((a, b) => a.start - b.start);

  if (fileChunks.length > 0) {
    parts.push(section("Implementation", format));
    for (const chunk of fileChunks) {
      const label = chunk.symbol
        ? `${chunk.symbol} — lines ${chunk.start}–${chunk.end}`
        : `lines ${chunk.start}–${chunk.end}`;
      parts.push(codeBlock(label, chunk.content, format));
    }
  }

  // ── Imports ────────────────────────────────────────────────────────────────
  const deps = depGraph[filePath];
  if (deps?.imports?.length) {
    parts.push(section("Imports", format));
    for (const imp of deps.imports) {
      const imported = imp.symbols.length > 0 ? ` { ${imp.symbols.join(", ")} }` : "";
      const impSummary = fileSummaries[imp.file]?.summary;
      parts.push(md
        ? `- \`${imp.file}\`${imported}${impSummary ? `\n  _${impSummary}_` : ""}`
        : `- ${imp.file}${imported}${impSummary ? `\n  ${impSummary}` : ""}`);
    }
  }

  // ── Imported by ────────────────────────────────────────────────────────────
  const importedByMap = computeImportedBy(depGraph);
  const importers = importedByMap.get(filePath) ?? [];
  if (importers.length > 0) {
    parts.push(section("Imported By", format));
    for (const importer of importers) {
      const impSummary = fileSummaries[importer]?.summary;
      parts.push(md
        ? `- \`${importer}\`${impSummary ? `\n  _${impSummary}_` : ""}`
        : `- ${importer}${impSummary ? `\n  ${impSummary}` : ""}`);
    }
  }

  // ── Call graph (outgoing) ─────────────────────────────────────────────────
  const outgoing = Object.entries(callGraph)
    .filter(([callerId]) => callerId.startsWith(filePath + ":"))
    .flatMap(([callerId, data]) =>
      data.calls.map((c) => ({ caller: callerId.split(":")[1] ?? callerId, ...c })),
    )
    .slice(0, 20);

  if (outgoing.length > 0) {
    parts.push(section("Outgoing Calls", format));
    for (const c of outgoing) {
      const loc = c.file ? `${c.file}:${c.line ?? "?"}` : "unknown";
      parts.push(md ? `- \`${c.caller}\` → \`${c.name}\` (${loc})` : `- ${c.caller} -> ${c.name} (${loc})`);
    }
  }

  // ── Call graph (incoming) ─────────────────────────────────────────────────
  const incoming = Object.entries(callGraph)
    .filter(([, data]) => data.calls.some((c) => c.file === filePath))
    .map(([callerId]) => callerId)
    .slice(0, 20);

  if (incoming.length > 0) {
    parts.push(section("Called By (callers in other files)", format));
    for (const caller of incoming) {
      parts.push(md ? `- \`${caller}\`` : `- ${caller}`);
    }
  }

  // ── Test files ─────────────────────────────────────────────────────────────
  parts.push(section("Test Files", format));
  const tests = findTestFiles(filePath, Object.keys(fileIndex), importedByMap);
  if (tests.length > 0) {
    for (const t of tests) parts.push(md ? `- \`${t}\`` : `- ${t}`);
  } else {
    parts.push(md ? "_None found._" : "(none found)");
  }

  // ── Knowledge ──────────────────────────────────────────────────────────────
  const knowledgeEntries = relatedKnowledge(knowledge, filePath, null);
  if (knowledgeEntries.length > 0) {
    parts.push(section("Related Knowledge", format));
    for (const e of knowledgeEntries) {
      parts.push(md
        ? `- **[${e.category}]** ${e.title}\n  ${e.body}`
        : `- [${e.category}] ${e.title}\n  ${e.body}`);
    }
  }

  return parts.join("\n");
}

// ─── Symbol focus ─────────────────────────────────────────────────────────────

function buildSymbolFocus(
  symbolName: string,
  chunks: Chunk[],
  symbols: SymbolIndex,
  depGraph: DependencyGraph,
  callGraph: CallGraph,
  fileSummaries: FileSummaryIndex,
  knowledge: KnowledgeEntry[],
  fileIndex: FileIndex,
  format: "markdown" | "plain",
  depth?: "method",
): string {
  const parts: string[] = [];
  const md = format === "markdown";
  const entry = symbols[symbolName];

  parts.push(md ? `# Focus: \`${symbolName}\`\n` : `=== Focus: ${symbolName} ===\n`);

  // Metadata
  const parentLabel = entry.parent ? `  **Parent:** \`${entry.parent}\`` : "";
  parts.push(md
    ? `**Type:** ${entry.type}  **File:** \`${entry.file}\`  **Lines:** ${entry.startLine}–${entry.endLine}  **Exported:** ${entry.exported}${parentLabel}`
    : `Type: ${entry.type}  File: ${entry.file}  Lines: ${entry.startLine}-${entry.endLine}  Exported: ${entry.exported}`);

  // ── File context ───────────────────────────────────────────────────────────
  const fileSummary = fileSummaries[entry.file]?.summary;
  if (fileSummary) {
    parts.push(section("File Context", format));
    parts.push(md ? `\`${entry.file}\` — ${fileSummary}` : `${entry.file} — ${fileSummary}`);
  }

  // ── Implementation ─────────────────────────────────────────────────────────
  const implChunk = chunks
    .filter((c) => c.symbol === symbolName && c.file === entry.file)
    .sort((a, b) => a.start - b.start)[0];

  if (implChunk) {
    parts.push(section("Implementation", format));
    parts.push(codeBlock(`${symbolName} — lines ${implChunk.start}–${implChunk.end}`, implChunk.content, format));
  }

  // ── Methods (when target is a class) ──────────────────────────────────────
  const members = Object.entries(symbols)
    .filter(([, e]) => e.parent === symbolName && e.file === entry.file)
    .sort(([, a], [, b]) => a.startLine - b.startLine);

  if (members.length > 0) {
    parts.push(section("Methods", format));
    for (const [name, e] of members) {
      parts.push(md
        ? `- \`${name}\` — ${e.type}, lines ${e.startLine}–${e.endLine}`
        : `- ${name} (${e.type}, lines ${e.startLine}-${e.endLine})`);
      if (depth === "method") {
        const methodChunk = chunks
          .filter((c) => c.symbol === name && c.file === e.file)
          .sort((a, b) => a.start - b.start)[0];
        if (methodChunk) {
          parts.push(codeBlock(`${name} — lines ${methodChunk.start}–${methodChunk.end}`, methodChunk.content, format));
        }
      }
    }
  }

  // ── Outgoing calls ─────────────────────────────────────────────────────────
  const callerId = `${entry.file}:${symbolName}`;
  const outgoing = callGraph[callerId]?.calls ?? [];
  if (outgoing.length > 0) {
    parts.push(section("Calls", format));
    for (const c of outgoing.slice(0, 15)) {
      const loc = c.file ? `${c.file}:${c.line ?? "?"}` : "unknown";
      parts.push(md ? `- \`${c.name}\` — ${loc}` : `- ${c.name} (${loc})`);
    }
  }

  // ── Incoming calls ─────────────────────────────────────────────────────────
  const calledByIds = callGraph[callerId]?.calledBy ?? [];
  // Also scan for callers that reference this symbol by name
  const scanCallers = Object.entries(callGraph)
    .filter(([cid, data]) =>
      cid !== callerId &&
      data.calls.some((c) => c.name === symbolName || c.name.endsWith(`.${symbolName}`)),
    )
    .map(([cid]) => cid)
    .filter((cid) => !calledByIds.includes(cid));

  const allCallers = [...calledByIds, ...scanCallers].slice(0, 15);
  if (allCallers.length > 0) {
    parts.push(section("Called By", format));
    for (const caller of allCallers) {
      parts.push(md ? `- \`${caller}\`` : `- ${caller}`);
    }
  }

  // ── Sibling symbols (same file, same parent class if any) ─────────────────
  const siblings = Object.entries(symbols)
    .filter(([name, e]) => name !== symbolName && e.file === entry.file && e.parent === entry.parent && e.parent !== undefined)
    .map(([name, e]) => `${name} (${e.type}, line ${e.startLine})`);

  if (siblings.length > 0) {
    parts.push(section(`Sibling Members of \`${entry.parent}\``, format));
    for (const s of siblings.slice(0, 10)) {
      parts.push(md ? `- \`${s}\`` : `- ${s}`);
    }
  }

  // ── Test files ─────────────────────────────────────────────────────────────
  parts.push(section("Test Files", format));
  const importedByMap = computeImportedBy(depGraph);
  const tests = findTestFiles(entry.file, Object.keys(fileIndex), importedByMap);
  if (tests.length > 0) {
    for (const t of tests) parts.push(md ? `- \`${t}\`` : `- ${t}`);
  } else {
    parts.push(md ? "_None found._" : "(none found)");
  }

  // ── Knowledge ──────────────────────────────────────────────────────────────
  const knowledgeEntries = relatedKnowledge(knowledge, entry.file, symbolName);
  if (knowledgeEntries.length > 0) {
    parts.push(section("Related Knowledge", format));
    for (const e of knowledgeEntries) {
      parts.push(md
        ? `- **[${e.category}]** ${e.title}\n  ${e.body}`
        : `- [${e.category}] ${e.title}\n  ${e.body}`);
    }
  }

  return parts.join("\n");
}

// ─── Main command ─────────────────────────────────────────────────────────────

export async function runFocus(
  rootDir: string,
  target: string,
  options: FocusOptions = {},
): Promise<void> {
  loadConfig(rootDir);

  const repo = new RepositoryStorage(rootDir);
  const chunks = repo.loadChunks();

  if (chunks.length === 0) {
    console.error(chalk.red("No index found. Run `vemora index` first."));
    process.exit(1);
  }

  const symbols = repo.loadSymbols();
  const depGraph = repo.loadDeps();
  const callGraph = repo.loadCallGraph();
  const fileIndex = repo.loadFiles();
  const fileSummaries = new SummaryStorage(rootDir).hasFileSummaries()
    ? new SummaryStorage(rootDir).loadFileSummaries()
    : {};
  const knowledge = new KnowledgeStorage(rootDir).load();
  const format = options.format ?? "markdown";

  // ── Resolve target ─────────────────────────────────────────────────────────
  let resolvedFile: string | null = null;
  let resolvedSymbol: string | null = null;

  if (looksLikeFilePath(target)) {
    resolvedFile = resolveFile(target, fileIndex);
    if (!resolvedFile) {
      console.error(chalk.red(`File not found in index: "${target}"`));
      console.error(chalk.gray("Use a path relative to the project root (e.g. src/commands/audit.ts)"));
      console.error(chalk.gray("Run `vemora status` to check the index."));
      process.exit(1);
    }
  } else {
    resolvedSymbol = resolveSymbol(target, symbols);
    if (!resolvedSymbol) {
      // Try as partial file path (e.g. user typed "cache" meaning "storage/cache.ts")
      resolvedFile = resolveFile(target, fileIndex);
    }
    if (!resolvedSymbol && !resolvedFile) {
      console.error(chalk.red(`"${target}" not found as a symbol or file in the index.`));
      console.error(chalk.gray("Examples:  vemora focus src/storage/cache.ts"));
      console.error(chalk.gray("           vemora focus EmbeddingCacheStorage"));
      process.exit(1);
    }
  }

  let output = resolvedFile
    ? buildFileFocus(resolvedFile, chunks, symbols, depGraph, callGraph, fileSummaries, knowledge, fileIndex, format, options.lines)
    : buildSymbolFocus(resolvedSymbol!, chunks, symbols, depGraph, callGraph, fileSummaries, knowledge, fileIndex, format, options.depth);

  if (options.budget && options.budget > 0) {
    const { text, truncated } = truncateToTokenBudget(output, options.budget);
    output = text;
    if (truncated) {
      output += `\n\n[...truncated to ${options.budget} token budget]`;
    }
  }

  console.log(output);
}

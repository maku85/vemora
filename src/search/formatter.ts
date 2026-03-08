import type {
  CallGraph,
  DependencyGraph,
  FileSummaryIndex,
  SearchResult,
} from "../core/types";
import { computeImportedBy } from "../indexer/deps";
import { extractSignature, getDisplayTier, HIGH_CODE_LINES } from "./signature";

export type OutputFormat = "terminal" | "json" | "markdown" | "terse";

export interface FormatOptions {
  format: OutputFormat;
  showCode?: boolean;
  topK?: number;
}

// ─── Terse formatter ──────────────────────────────────────────────────────────

/**
 * Ultra-compact one-liner per result for small/local models with limited context windows.
 * Format: file:startLine | symbol (type) | score | first-line-of-signature
 *
 * ~70-80% fewer tokens than the markdown format. Recommended for models with
 * context windows ≤ 32K, or whenever token budget is the primary constraint.
 */
export function formatTerse(
  results: SearchResult[],
  options: Pick<FormatOptions, "topK">,
): string {
  const topK = options.topK ?? 10;
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const { chunk, score, symbol } of results) {
    if (seen.has(chunk.id)) continue;
    seen.add(chunk.id);

    const symbolPart = chunk.symbol
      ? `${chunk.symbol} (${symbol?.type ?? "symbol"})`
      : "(no symbol)";
    const sig = extractSignature(chunk.content).split("\n")[0].trim();

    lines.push(
      `${chunk.file}:${chunk.start} | ${symbolPart} | ${score.toFixed(3)} | ${sig}`,
    );

    if (lines.length >= topK) break;
  }

  return lines.join("\n");
}

// ─── JSON formatter ───────────────────────────────────────────────────────────

export interface JsonResult {
  rank: number;
  tier: "high" | "med" | "low";
  file: string;
  symbol: string | null;
  symbolType: string | null;
  lines: { start: number; end: number };
  score: number;
  code: string | null;
  signature: string | null;
  imports: Array<{ file: string; symbols: string[] }>;
  usedBy: string[];
  summary: string | null;
}

export interface JsonOutput {
  query: string;
  totalResults: number;
  results: JsonResult[];
}

export function formatJson(
  query: string,
  results: SearchResult[],
  depGraph: DependencyGraph,
  fileSummaries: FileSummaryIndex,
  options: FormatOptions,
): string {
  const importedByMap = computeImportedBy(depGraph);
  const showCode = options.showCode ?? false;
  const topK = options.topK ?? 10;

  const seen = new Set<string>();
  const jsonResults: JsonResult[] = [];

  for (const { chunk, score, symbol } of results) {
    if (seen.has(chunk.id)) continue;
    seen.add(chunk.id);

    const rank = jsonResults.length + 1;
    const tier = showCode ? "high" : getDisplayTier(rank);

    const fileDeps = depGraph[chunk.file];
    const usedBy = importedByMap.get(chunk.file) ?? [];

    let code: string | null = null;
    let signature: string | null = null;

    if (tier === "high") {
      const codeLines = chunk.content.split("\n");
      const limit = showCode ? codeLines.length : HIGH_CODE_LINES;
      code = codeLines.slice(0, limit).join("\n");
    } else if (tier === "med") {
      signature = extractSignature(chunk.content);
    }

    const fileSummary = fileSummaries[chunk.file];

    jsonResults.push({
      rank,
      tier,
      file: chunk.file,
      symbol: chunk.symbol ?? null,
      symbolType: symbol?.type ?? null,
      lines: { start: chunk.start, end: chunk.end },
      score: parseFloat(score.toFixed(4)),
      code,
      signature,
      imports: fileDeps?.imports ?? [],
      usedBy,
      summary: fileSummary?.summary ?? null,
    });

    if (jsonResults.length >= topK) break;
  }

  const output: JsonOutput = {
    query,
    totalResults: jsonResults.length,
    results: jsonResults,
  };

  return JSON.stringify(output, null, 2);
}

// ─── Markdown formatter ───────────────────────────────────────────────────────

export function formatMarkdown(
  query: string,
  results: SearchResult[],
  depGraph: DependencyGraph,
  fileSummaries: FileSummaryIndex,
  callGraph: CallGraph,
  options: FormatOptions,
): string {
  const importedByMap = computeImportedBy(depGraph);
  const showCode = options.showCode ?? false;
  const topK = options.topK ?? 10;

  const lines: string[] = [];
  lines.push(`## Relevant code for: \`${query}\``);
  lines.push("");

  const seen = new Set<string>();
  let displayed = 0;

  for (const { chunk, score, symbol } of results) {
    if (seen.has(chunk.id)) continue;
    seen.add(chunk.id);

    const rank = displayed + 1;
    const tier = showCode ? "high" : getDisplayTier(rank);

    // Header
    lines.push(`### ${rank}. \`${chunk.file}\``);
    if (chunk.symbol) {
      const symType = symbol?.type ?? "symbol";
      lines.push(`**${symType}** \`${chunk.symbol}\`  `);
    }
    lines.push(
      `Lines ${chunk.start}–${chunk.end} · Score: ${score.toFixed(4)} · Tier: ${tier}`,
    );
    lines.push("");

    // Dependencies
    if (tier !== "low") {
      const fileDeps = depGraph[chunk.file];
      const usedBy = importedByMap.get(chunk.file) ?? [];

      if (fileDeps?.imports.length) {
        const maxDeps = tier === "high" ? 6 : 3;
        const shown = fileDeps.imports.slice(0, maxDeps);
        const hidden = fileDeps.imports.length - shown.length;

        lines.push("**Imports:**");
        for (const imp of shown) {
          const syms =
            imp.symbols.length > 0
              ? ` — \`${imp.symbols.slice(0, 4).join(", ")}\``
              : "";
          lines.push(`- \`${imp.file}\`${syms}`);
        }
        if (hidden > 0) lines.push(`- _…and ${hidden} more_`);
        lines.push("");
      }

      if (usedBy.length > 0) {
        const maxUsed = tier === "high" ? 4 : 2;
        const shown = usedBy.slice(0, maxUsed);
        const hidden = usedBy.length - shown.length;

        lines.push("**Used by (files):**");
        for (const caller of shown) {
          lines.push(`- \`${caller}\``);
        }
        if (hidden > 0) lines.push(`- _…and ${hidden} more_`);
        lines.push("");
      }

      // Call Graph context
      const symbolId = chunk.symbol ? `${chunk.file}:${chunk.symbol}` : null;
      const callInfo = symbolId ? callGraph[symbolId] : null;

      if (callInfo) {
        if (callInfo.calls.length > 0) {
          const maxCalls = tier === "high" ? 6 : 3;
          const shown = callInfo.calls.slice(0, maxCalls);
          const hidden = callInfo.calls.length - shown.length;

          lines.push("**Calls:**");
          for (const call of shown) {
            const loc = call.file ? ` (in \`${call.file}\`)` : "";
            lines.push(`- \`${call.name}\`${loc}`);
          }
          if (hidden > 0) lines.push(`- _…and ${hidden} more_`);
          lines.push("");
        }

        if (callInfo.calledBy.length > 0) {
          const maxCallers = tier === "high" ? 4 : 2;
          const shown = callInfo.calledBy.slice(0, maxCallers);
          const hidden = callInfo.calledBy.length - shown.length;

          lines.push("**Called by:**");
          for (const callerId of shown) {
            lines.push(`- \`${callerId}\``);
          }
          if (hidden > 0) lines.push(`- _…and ${hidden} more_`);
          lines.push("");
        }
      }
    }

    // Code / signature / summary
    if (tier === "high") {
      const codeLines = chunk.content.split("\n");
      const limit = showCode ? codeLines.length : HIGH_CODE_LINES;
      const preview = codeLines.slice(0, limit).join("\n");
      const ext = chunk.file.split(".").pop() ?? "";
      lines.push(`\`\`\`${ext}`);
      lines.push(preview);
      if (codeLines.length > limit) {
        lines.push(
          `// … (${codeLines.length - limit} more lines — use --show-code to expand)`,
        );
      }
      lines.push("```");
    } else if (tier === "med") {
      const sig = extractSignature(chunk.content);
      const ext = chunk.file.split(".").pop() ?? "";
      lines.push(`\`\`\`${ext}`);
      lines.push(sig);
      lines.push("```");
    } else {
      // LOW — summary if available
      const fileSummary = fileSummaries[chunk.file];
      if (fileSummary) {
        lines.push(`> ${fileSummary.summary}`);
      }
    }

    lines.push("");
    lines.push("---");
    lines.push("");

    displayed++;
    if (displayed >= topK) break;
  }

  if (displayed === 0) {
    lines.push("_No results found._");
  }

  return lines.join("\n");
}

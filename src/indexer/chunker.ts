import type { AiMemoryConfig, Chunk } from "../core/types";
import { hashContent } from "./hasher";
import type { ParsedSymbol } from "./parser";

/**
 * Splits a file into chunks suitable for embedding and retrieval.
 *
 * Strategy:
 *  1. If tree-sitter gave us symbol boundaries with real line ranges,
 *     create one chunk per symbol (split further if too large).
 *  2. Otherwise fall back to a sliding window chunker.
 *
 * Chunk IDs are derived from file path + content hash, so unchanged code
 * keeps the same ID across re-indexing — enabling embedding cache reuse.
 */
export function chunkFile(
  filePath: string,
  content: string,
  symbols: ParsedSymbol[],
  config: AiMemoryConfig,
): Chunk[] {
  const lines = content.split("\n");

  const hasBoundaries = symbols.some((s) => s.endLine > s.startLine);

  if (hasBoundaries) {
    return chunkBySymbols(filePath, lines, symbols, config);
  }

  return chunkBySlidingWindow(filePath, lines, 1, config);
}

// ─── Class header extraction ──────────────────────────────────────────────────

/**
 * Maximum number of lines to include in a class header (class declaration +
 * property declarations). Caps the header when the constructor body is large.
 */
const CLASS_HEADER_MAX_LINES = 25;

/**
 * Builds a map of className → header snippet for classes that have methods.
 *
 * The header covers the class declaration line plus all content up to the
 * first method start (e.g. property declarations, constructor signature).
 * It is capped at CLASS_HEADER_MAX_LINES to avoid bloating method chunks.
 *
 * Only classes with at least 2 header lines (declaration + at least one
 * property/constructor) get an entry — bare `class Foo {` headers are skipped.
 */
function buildClassHeaders(
  lines: string[],
  symbols: ParsedSymbol[],
): Map<string, string> {
  const headers = new Map<string, string>();

  // Find the earliest method start line per parent class
  const firstMethodLine = new Map<string, number>();
  for (const sym of symbols) {
    if (sym.type === "method" && sym.parent) {
      const existing = firstMethodLine.get(sym.parent);
      if (existing === undefined || sym.startLine < existing) {
        firstMethodLine.set(sym.parent, sym.startLine);
      }
    }
  }

  for (const cls of symbols) {
    if (cls.type !== "class" || cls.endLine <= cls.startLine) continue;
    const firstMethod = firstMethodLine.get(cls.name);
    if (!firstMethod) continue;

    const headerEndLine = Math.min(
      firstMethod - 1,
      cls.startLine + CLASS_HEADER_MAX_LINES - 1,
    );
    const headerLines = lines.slice(cls.startLine - 1, headerEndLine);

    // Trim trailing blank lines
    while (headerLines.length > 0 && !headerLines[headerLines.length - 1].trim()) {
      headerLines.pop();
    }

    // Require at least 2 lines (class declaration + something meaningful)
    if (headerLines.length >= 2) {
      headers.set(cls.name, headerLines.join("\n"));
    }
  }

  return headers;
}

// ─── Symbol-based chunking ────────────────────────────────────────────────────

function chunkBySymbols(
  filePath: string,
  lines: string[],
  symbols: ParsedSymbol[],
  config: AiMemoryConfig,
): Chunk[] {
  const chunks: Chunk[] = [];
  const classHeaders = buildClassHeaders(lines, symbols);

  const bounded = symbols
    .filter((s) => s.endLine > s.startLine)
    .sort((a, b) => a.startLine - b.startLine);

  // Include the file header (imports, top-level declarations) as its own chunk
  const firstSymbolStart = bounded[0]?.startLine ?? lines.length + 1;
  if (firstSymbolStart > 5) {
    const headerLines = lines.slice(0, firstSymbolStart - 1);
    const headerContent = headerLines.join("\n").trim();
    if (headerContent.length > 30) {
      chunks.push(makeChunk(filePath, headerContent, 1, firstSymbolStart - 1));
    }
  }

  for (const sym of bounded) {
    const symLines = lines.slice(sym.startLine - 1, sym.endLine);

    // For method chunks: prepend the parent class header so the LLM sees the
    // class properties and constructor context alongside the method body.
    let symContent = symLines.join("\n");
    if (sym.type === "method" && sym.parent) {
      const header = classHeaders.get(sym.parent);
      if (header) {
        symContent = `${header}\n\n  // ...\n\n${symLines.join("\n")}`;
      }
    }

    if (
      symLines.length > config.maxChunkLines ||
      symContent.length > config.maxChunkChars
    ) {
      // Symbol body is too large — fall back to sliding window on the raw
      // method lines (without header) to avoid doubling the size.
      const subChunks = chunkBySlidingWindow(
        filePath,
        symLines,
        sym.startLine,
        config,
        sym.name,
      );
      chunks.push(...subChunks);
    } else {
      chunks.push(
        makeChunk(filePath, symContent, sym.startLine, sym.endLine, sym.name),
      );
    }
  }

  // Any trailing content after the last symbol
  const lastEnd = bounded[bounded.length - 1]?.endLine ?? 0;
  if (lastEnd < lines.length) {
    const tailContent = lines.slice(lastEnd).join("\n").trim();
    if (tailContent.length > 50) {
      chunks.push(makeChunk(filePath, tailContent, lastEnd + 1, lines.length));
    }
  }

  return chunks;
}

// ─── Sliding-window chunking ──────────────────────────────────────────────────

/**
 * Splits lines into overlapping chunks of maxChunkLines each.
 * A 10% overlap preserves context at chunk boundaries.
 *
 * @param lineOffset - 1-based line number of lines[0] in the original file
 * @param symbol     - symbol name to attach to all sub-chunks (optional)
 */
function chunkBySlidingWindow(
  filePath: string,
  lines: string[],
  lineOffset: number,
  config: AiMemoryConfig,
  symbol?: string,
): Chunk[] {
  const chunks: Chunk[] = [];
  const overlap = Math.max(1, Math.floor(config.maxChunkLines * 0.1));
  let i = 0;

  while (i < lines.length) {
    const slice = lines.slice(i, i + config.maxChunkLines);
    const content = slice.join("\n");

    if (content.trim().length > 0) {
      const startLine = lineOffset + i;
      const endLine = lineOffset + i + slice.length - 1;
      chunks.push(makeChunk(filePath, content, startLine, endLine, symbol));
    }

    if (i + config.maxChunkLines >= lines.length) break;
    i += config.maxChunkLines - overlap;
  }

  return chunks;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeChunk(
  file: string,
  content: string,
  start: number,
  end: number,
  symbol?: string,
): Chunk {
  // ID is based on file path + content so identical code in different branches
  // gets the same ID and can reuse cached embeddings.
  const id = hashContent(file + "\n" + content);
  return { id, file, start, end, symbol, content };
}

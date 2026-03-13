import type { AiMemoryConfig, Chunk } from "../core/types";
import type { ParsedSymbol } from "./parser";
import { buildClassHeaders } from "./classHeader";
import { hashContent } from "./hasher";
import { chunkBySlidingWindow } from "./chunkBySlidingWindow";

/**
 * Chunking basato su simboli.
 */
export function chunkBySymbols(
  filePath: string,
  lines: string[],
  symbols: ParsedSymbol[],
  config: AiMemoryConfig,
): Chunk[] {
  const chunks: Chunk[] = [];
  const classHeaders = buildClassHeaders(lines, symbols);

  const bounded = symbols
    .filter((s) => s.endLine >= s.startLine)
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

function makeChunk(
  file: string,
  content: string,
  start: number,
  end: number,
  symbol?: string,
): Chunk {
  const id = hashContent(file + "\n" + content);
  return { id, file, start, end, symbol, content };
}

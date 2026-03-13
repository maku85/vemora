import type { AiMemoryConfig, Chunk } from "../core/types";
import { hashContent } from "./hasher";

/**
 * Chunking sliding window.
 */
export function chunkBySlidingWindow(
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

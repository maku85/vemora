import type { AiMemoryConfig, Chunk } from "../core/types";
import type { ParsedSymbol } from "./parser";
import { selectChunkingStrategy } from "./strategy";
import { chunkBySymbols } from "./chunkBySymbols";
import { chunkBySlidingWindow } from "./chunkBySlidingWindow";

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
  const strategy = selectChunkingStrategy(symbols);
  if (strategy === "symbol") {
    return chunkBySymbols(filePath, lines, symbols, config);
  }
  return chunkBySlidingWindow(filePath, lines, 1, config);
}


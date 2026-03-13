import type { ParsedSymbol } from "./parser";

/**
 * Decides which chunking strategy to use based on the presence of valid symbols.
 * If there are symbols with endLine >= startLine, we assume the parser worked and use symbol-based chunking.
 * Otherwise, we fall back to sliding window chunking.
 * This allows us to handle cases where the parser fails or returns incomplete symbols without losing all structure.
 * Note: we check for endLine >= startLine to allow for symbols that are only one line long (e.g., simple functions or
 * properties) while still filtering out invalid symbols with endLine = 0 or endLine < startLine.
 */
export function selectChunkingStrategy(symbols: ParsedSymbol[]): "symbol" | "sliding" {
  return symbols.some((s) => s.endLine >= s.startLine) ? "symbol" : "sliding";
}

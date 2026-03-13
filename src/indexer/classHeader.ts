import type { ParsedSymbol } from "./parser";

export const CLASS_HEADER_MAX_LINES = 25;

/**
 * Builds a map of className → header snippet for classes that have methods.
 */
export function buildClassHeaders(
  lines: string[],
  symbols: ParsedSymbol[],
): Map<string, string> {
  const headers = new Map<string, string>();
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
    while (headerLines.length > 0 && !headerLines[headerLines.length - 1].trim()) {
      headerLines.pop();
    }
    if (headerLines.length >= 2) {
      headers.set(cls.name, headerLines.join("\n"));
    }
  }
  return headers;
}

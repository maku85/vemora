import type { SearchResult } from "../core/types";

/** Sums the estimated token count across a list of search results. */
export function sumResultTokens(results: SearchResult[]): number {
  return results.reduce((n, r) => n + countTokensHeuristic(r.chunk.content), 0);
}

/**
 * Heuristic-based token counting.
 *
 * Exact token counts depend on the model's tokenizer (e.g. Tiktoken for OpenAI,
 * LlamaTokenizer for Mistral/Ollama). For a general CLI comparison, a conservative
 * heuristic of ~3.2 characters per token is standard for code-heavy content.
 */
export function countTokensHeuristic(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.2);
}

/**
 * Returns a formatted string with token count and size in KB.
 */
export function formatTokenStats(text: string): string {
  const tokens = countTokensHeuristic(text);
  const kb = (Buffer.byteLength(text, "utf8") / 1024).toFixed(2);
  return `${tokens.toLocaleString()} tokens (~${kb} KB)`;
}

/**
 * Filters a ranked list of SearchResults to fit within a token budget.
 *
 * Iterates in score order, accumulating chunk token counts until the budget
 * would be exceeded. The first result is always included even if it alone
 * exceeds the budget (never return empty when results exist).
 */
export function applyTokenBudget(
  results: SearchResult[],
  budget: number,
): SearchResult[] {
  if (budget <= 0) return results;
  let tokens = 0;
  const filtered: SearchResult[] = [];
  for (const r of results) {
    const t = countTokensHeuristic(r.chunk.content);
    if (filtered.length === 0 || tokens + t <= budget) {
      tokens += t;
      filtered.push(r);
    }
  }
  return filtered;
}

import type { EmbeddingCache, SearchResult } from "../core/types";
import { cosineSimilarity } from "./vector";

/**
 * Merges adjacent or overlapping chunks from the same file into a single chunk.
 *
 * Two chunks are merged when the next chunk's start line is within `gapThreshold`
 * lines of the current chunk's end line. Overlapping lines (from sliding-window
 * chunks) are deduplicated by skipping the already-covered lines when appending.
 *
 * Properties of the merged result:
 *  - `start` / `end` span the full combined line range
 *  - `content` is reconstructed without duplication
 *  - `score` is the maximum score among merged chunks
 *  - `symbol` is preserved only when all merged chunks share the same symbol name
 *
 * @param results      Search results (any order).
 * @param gapThreshold Max line gap between chunks to still merge them (default: 3).
 */
export function mergeAdjacentChunks(
  results: SearchResult[],
  gapThreshold = 3,
): SearchResult[] {
  if (results.length <= 1) return results;

  // Group results by file
  const byFile = new Map<string, SearchResult[]>();
  for (const result of results) {
    const list = byFile.get(result.chunk.file) ?? [];
    list.push(result);
    byFile.set(result.chunk.file, list);
  }

  const merged: SearchResult[] = [];

  for (const fileResults of byFile.values()) {
    // Sort ascending by start line so we can merge left-to-right
    const sorted = [...fileResults].sort(
      (a, b) => a.chunk.start - b.chunk.start,
    );
    let cur = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i];

      if (next.chunk.start <= cur.chunk.end + gapThreshold) {
        // Deduplicate overlapping lines: compute how many lines of `next` are
        // already covered by `cur` based on line numbers, but cap at the actual
        // content length to handle reconstructed (previously merged) chunks.
        const overlapByLineNum = Math.max(
          0,
          cur.chunk.end - next.chunk.start + 1,
        );
        const nextLines = next.chunk.content.split("\n");
        const overlapLines = Math.min(overlapByLineNum, nextLines.length);
        const appendLines = nextLines.slice(overlapLines);

        const mergedContent =
          appendLines.length > 0
            ? cur.chunk.content + "\n" + appendLines.join("\n")
            : cur.chunk.content;

        const mergedSymbol =
          cur.chunk.symbol !== undefined &&
          cur.chunk.symbol === next.chunk.symbol
            ? cur.chunk.symbol
            : undefined;

        cur = {
          chunk: {
            id: cur.chunk.id + "+" + next.chunk.id,
            file: cur.chunk.file,
            start: cur.chunk.start,
            end: Math.max(cur.chunk.end, next.chunk.end),
            symbol: mergedSymbol,
            content: mergedContent,
          },
          score: Math.max(cur.score, next.score),
          symbol:
            mergedSymbol !== undefined
              ? (cur.symbol ?? next.symbol)
              : undefined,
        };
      } else {
        merged.push(cur);
        cur = next;
      }
    }

    merged.push(cur);
  }

  // Restore score-descending order
  return merged.sort((a, b) => b.score - a.score);
}

// ─── Semantic deduplication ───────────────────────────────────────────────────

/**
 * Removes near-duplicate chunks before token budget is applied.
 *
 * Two chunks are considered near-duplicates when:
 *  - Embeddings available: cosineSimilarity(a, b) > threshold (default 0.92)
 *  - No embeddings:        Jaccard similarity of word-token sets > 0.80
 *
 * Processes results in score order (highest first); earlier chunks win.
 * The first result is always kept regardless of similarity.
 *
 * @param cache     Embedding cache (may be null — falls back to Jaccard)
 * @param threshold Cosine similarity above which two chunks are near-duplicates
 */
export function deduplicateBySimilarity(
  results: SearchResult[],
  cache: EmbeddingCache | null,
  threshold = 0.92,
): SearchResult[] {
  if (results.length <= 1) return results;

  // Precompute a mapping from chunk ID to embedding for O(1) retrieval during deduplication.
  let idToIndex: Map<string, number> | undefined;
  if (cache && cache.chunkIds) {
    idToIndex = new Map(cache.chunkIds.map((id, i) => [id, i]));
  }
  const embeddingOf = (id: string): number[] | null => {
    if (!cache) return null;
    // Dense binary format (chunkIds + vectors buffer)
    if (cache.chunkIds && cache.vectors && idToIndex) {
      const idx = idToIndex.get(id);
      if (idx !== undefined) {
        const dims = cache.dimensions;
        return Array.from(cache.vectors.subarray(idx * dims, idx * dims + dims));
      }
    }
    // Legacy map format
    return cache.embeddings?.[id] ?? null;
  };

  const selected: SearchResult[] = [];
  const selectedEmbeddings: Array<number[] | null> = [];

  for (const candidate of results) {
    const candidateEmb = embeddingOf(candidate.chunk.id);
    let tooSimilar = false;

    for (let i = 0; i < selected.length; i++) {
      const selEmb = selectedEmbeddings[i];
      if (candidateEmb && selEmb) {
        tooSimilar = cosineSimilarity(candidateEmb, selEmb) > threshold;
      } else {
        tooSimilar =
          jaccardSimilarity(candidate.chunk.content, selected[i].chunk.content) >
          0.65;
      }
      if (tooSimilar) break;
    }

    if (!tooSimilar) {
      selected.push(candidate);
      selectedEmbeddings.push(candidateEmb);
    }
  }

  return selected;
}

function jaccardSimilarity(a: string, b: string): number {
  const tokA = wordTokens(a);
  const tokB = wordTokens(b);
  if (tokA.size === 0 && tokB.size === 0) return 1;

  let intersection = 0;
  for (const t of tokA) if (tokB.has(t)) intersection++;
  const union = tokA.size + tokB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function wordTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s\W]+/)
      .filter((t) => t.length >= 2),
  );
}

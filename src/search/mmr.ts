import type { EmbeddingCache, SearchResult } from "../core/types";
import { cosineSimilarityBinary } from "./vector";

/**
 * Maximal Marginal Relevance (MMR) reranking.
 *
 * Selects up to `topK` results from `candidates` by iteratively picking
 * the candidate that maximises:
 *
 *   MMR(d) = lambda * relevance(d) - (1 - lambda) * max_sim(d, selected)
 *
 * where:
 *   - relevance(d) is the original retrieval score (normalised to [0, 1])
 *   - max_sim(d, selected) is the maximum cosine similarity between d and
 *     any already-selected result (requires embeddings in the cache)
 *
 * lambda=1.0 → pure relevance ordering (identical to original ranking)
 * lambda=0.5 → balanced relevance / diversity (default)
 * lambda=0.0 → maximum diversity, ignores relevance
 *
 * Falls back to returning `candidates.slice(0, topK)` when embeddings
 * are unavailable (keyword-only mode).
 */
export function applyMMR(
  candidates: SearchResult[],
  cache: EmbeddingCache | null,
  topK: number,
  lambda = 0.5,
): SearchResult[] {
  if (candidates.length <= 1) return candidates.slice(0, topK);

  // Without vector data MMR cannot compute inter-result similarity.
  if (!cache?.vectors || !cache.chunkIds || !cache.dimensions) {
    return candidates.slice(0, topK);
  }

  const { vectors, chunkIds, dimensions } = cache;

  // Build a fast chunk-id → flat-buffer-index map.
  const idToIdx = new Map<string, number>();
  chunkIds.forEach((id, i) => idToIdx.set(id, i));

  // Normalise relevance scores to [0, 1] so lambda is meaningful regardless
  // of whether scores come from cosine similarity (already ~[0,1]) or BM25.
  // Use reduce instead of Math.max(...spread) to avoid call-stack overflow on large arrays.
  let maxScore = -Infinity;
  let minScore = Infinity;
  for (const r of candidates) {
    if (r.score > maxScore) maxScore = r.score;
    if (r.score < minScore) minScore = r.score;
  }
  const range = maxScore - minScore || 1;
  const relNorm = candidates.map((r) => (r.score - minScore) / range);

  // Pre-extract each candidate's vector as number[] so the inner loop avoids
  // repeated Array.from() allocations (O(n² * d) → O(n * d) allocations).
  const candidateVecs: Array<number[] | null> = candidates.map((r) => {
    const idx = idToIdx.get(r.chunk.id);
    if (idx === undefined) return null;
    const offset = idx * dimensions;
    return Array.from(vectors.subarray(offset, offset + dimensions));
  });

  const selected: SearchResult[] = [];
  // Flat-buffer indices of already-selected results (for similarity queries).
  const selectedVecIdx: number[] = [];

  // Track remaining candidates as index positions into `candidates`.
  const remaining = candidates.map((_, i) => i);

  while (selected.length < topK && remaining.length > 0) {
    let bestPos = -1; // position in `remaining`
    let bestMMR = -Infinity;

    for (let pos = 0; pos < remaining.length; pos++) {
      const candIdx = remaining[pos];
      const relevance = relNorm[candIdx];

      let maxSim = 0;
      if (selectedVecIdx.length > 0) {
        const vecA = candidateVecs[candIdx];
        if (vecA !== null) {
          for (const selIdx of selectedVecIdx) {
            const sim = cosineSimilarityBinary(
              vecA,
              vectors,
              selIdx * dimensions,
              dimensions,
            );
            if (sim > maxSim) maxSim = sim;
          }
        }
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      if (mmrScore > bestMMR) {
        bestMMR = mmrScore;
        bestPos = pos;
      }
    }

    const chosenIdx = remaining[bestPos];
    selected.push(candidates[chosenIdx]);

    const vecIdx = idToIdx.get(candidates[chosenIdx].chunk.id);
    if (vecIdx !== undefined) selectedVecIdx.push(vecIdx);

    remaining.splice(bestPos, 1);
  }

  return selected;
}

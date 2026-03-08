import type {
  Chunk,
  EmbeddingCache,
  SearchResult,
  SymbolEntry,
  SymbolIndex,
} from "../core/types";
import { computeBM25Scores } from "./bm25";
import { vectorSearch } from "./vector";

export interface HybridOptions {
  alpha?: number; // Weight for vector search (0 to 1). Default: 0.7
  topK?: number;
}

/**
 * Combines Vector Search (semantic) and BM25 Search (keyword) for higher accuracy.
 */
export async function hybridSearch(
  query: string,
  queryEmbedding: number[] | null,
  chunks: Chunk[],
  cache: EmbeddingCache,
  symbols: SymbolIndex,
  options: HybridOptions = {},
): Promise<SearchResult[]> {
  const alpha = options.alpha ?? 0.7;
  const topK = options.topK ?? 10;

  // 1. Get Vector Scores
  let vectorResults: SearchResult[] = [];
  if (queryEmbedding && queryEmbedding.length > 0) {
    // We pass chunks.length to get all scores before filtering
    vectorResults = vectorSearch(
      queryEmbedding,
      chunks,
      cache,
      symbols,
      chunks.length,
    );
  }

  // 2. Get BM25 Scores
  const bm25Results = computeBM25Scores(query, chunks, symbols, chunks.length);

  // 3. Normalize and Combine
  const combinedMap = new Map<
    string,
    { chunk: Chunk; score: number; symbol?: SymbolEntry }
  >();

  // Map for easy access and O(1) retrieval
  const vMap = new Map<string, { score: number; result: SearchResult }>();
  vectorResults.forEach((r) =>
    vMap.set(r.chunk.id, { score: r.score, result: r }),
  );

  const bMap = new Map<string, { score: number; result: SearchResult }>();
  // Normalize BM25 scores to [0, 1] relative to the max BM25 score found
  const maxBM25 =
    bm25Results.length > 0 ? Math.max(...bm25Results.map((r) => r.score)) : 1;
  bm25Results.forEach((r) =>
    bMap.set(r.chunk.id, { score: r.score / maxBM25, result: r }),
  );

  // Iterate over all chunks that appeared in either result
  const allIds = new Set([...vMap.keys(), ...bMap.keys()]);

  for (const id of allIds) {
    const vData = vMap.get(id);
    const bData = bMap.get(id);

    const vScore = vData?.score || 0;
    const bScore = bData?.score || 0;

    // Weighted combination
    const finalScore = alpha * vScore + (1 - alpha) * bScore;

    // Retrieve chunk and symbol in O(1)
    const result = vData?.result || bData?.result;
    if (result) {
      combinedMap.set(id, {
        chunk: result.chunk,
        score: finalScore,
        symbol: result.symbol,
      });
    }
  }

  // 4. Sort and Slice
  return Array.from(combinedMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

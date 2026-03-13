import type { Chunk, SearchResult, SymbolIndex } from "../core/types";

/**
 * BM25 implementation for high-precision keyword search.
 */

const K1 = 1.5;
const B = 0.75;

// --- In-Memory Cache for BM25 (vital for chat session performance) ---
interface BM25Cache {
  chunkIdsHash: string;
  docTokens: string[][];
  tfMaps: Map<string, number>[];
  dfMap: Map<string, number>;
  avgdl: number;
  N: number;
}

let bm25Cache: BM25Cache | null = null;

function computeHash(chunks: Chunk[]): string {
  if (chunks.length === 0) return "";
  const chunkIds = chunks.map((c) => c.id).sort();
  return chunkIds.join("|");
}

export function computeBM25Scores(
  query: string,
  chunks: Chunk[],
  symbols: SymbolIndex,
  topK = 10,
): SearchResult[] {
  // 1. Tokenize query
  const queryTerms = query
    .toLowerCase()
    .split(/[\s\W]+/)
    .filter((t) => t.length >= 2); // Slightly more inclusive than current TF search

  if (queryTerms.length === 0) return [];

  const N = chunks.length;
  if (N === 0) return [];

  const currentHash = computeHash(chunks);

  // 2. Tokenize docs and compute stats (with CACHING)
  if (!bm25Cache || bm25Cache.chunkIdsHash !== currentHash) {
    // Cache miss: compute everything
    const docTokens: string[][] = [];
    const tfMaps: Map<string, number>[] = [];
    let totalLen = 0;
    const dfMap = new Map<string, number>();

    for (const chunk of chunks) {
      const tokens = chunk.content.toLowerCase().split(/[\s\W]+/);
      docTokens.push(tokens);
      totalLen += tokens.length;

      const tfMap = new Map<string, number>();
      for (const token of tokens) {
        tfMap.set(token, (tfMap.get(token) || 0) + 1);
      }
      tfMaps.push(tfMap);

      // Unique tokens for DF calculation
      for (const token of tfMap.keys()) {
        dfMap.set(token, (dfMap.get(token) || 0) + 1);
      }
    }

    bm25Cache = {
      chunkIdsHash: currentHash,
      docTokens,
      tfMaps,
      dfMap,
      avgdl: totalLen / N,
      N,
    };
  }

  const { docTokens, tfMaps, dfMap, avgdl } = bm25Cache;

  // 3. Compute IDF for query terms
  const idfMap = new Map<string, number>();
  for (const term of queryTerms) {
    const df = dfMap.get(term) || 0;
    // Standard BM25 IDF: ln((N - df + 0.5) / (df + 0.5) + 1)
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
    idfMap.set(term, Math.max(0, idf)); // IDF can be negative if term is in > half docs
  }

  // 4. Compute BM25 scores
  const results: SearchResult[] = chunks.map((chunk, i) => {
    const tokens = docTokens[i];
    const tfMap = tfMaps[i];
    const dl = tokens.length;
    let score = 0;

    for (const term of queryTerms) {
      const tf = tfMap.get(term) || 0;
      const idf = idfMap.get(term) || 0;

      // BM25 Formula: IDF * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgdl)))
      const numerator = tf * (K1 + 1);
      const denominator = tf + K1 * (1 - B + B * (dl / avgdl));
      score += idf * (numerator / denominator);
    }

    // Bonus: exact symbol match
    if (chunk.symbol) {
      const symLower = chunk.symbol.toLowerCase();
      if (queryTerms.some((t) => symLower.includes(t))) {
        // Boost for keyword match in symbol name
        score *= 1.5;
      }
      if (queryTerms.some((t) => symLower === t)) {
        // Higher boost for exact identifier match
        score *= 2.0;
      }
    }

    const symbol = chunk.symbol ? symbols[chunk.symbol] : undefined;
    return { chunk, score, symbol };
  });

  // 5. Sort and return
  return results
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

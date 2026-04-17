import type {
  Chunk,
  EmbeddingCache,
  SearchResult,
  SymbolIndex,
} from "../core/types";

// ─── Cosine Similarity ────────────────────────────────────────────────────────

/**
 * Computes cosine similarity between two vectors.
 * Returns a value in [-1, 1]. For normalized embeddings (OpenAI, Ollama)
 * this is effectively in [0, 1] for semantically related pairs.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Fast cosine similarity between a number[] and a Float32Array slice.
 */
export function cosineSimilarityBinary(
  query: number[],
  vectors: Float32Array,
  offset: number,
  dims: number,
): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < dims; i++) {
    const valB = vectors[offset + i];
    dot += query[i] * valB;
    normA += query[i] * query[i];
    normB += valB * valB;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Vector Search ────────────────────────────────────────────────────────────

/**
 * Performs an exhaustive nearest-neighbor search over all cached embeddings.
 *
 * Uses HNSW (O(log N)) when the index is available in the cache.
 * Falls back to exhaustive O(n * d) cosine search on the contiguous
 * Float32Array buffer if the HNSW index is missing or fails to load.
 */
export function vectorSearch(
  queryEmbedding: number[],
  chunks: Chunk[],
  cache: EmbeddingCache,
  symbols: SymbolIndex,
  topK = 10,
): SearchResult[] {
  if (queryEmbedding.length === 0) return [];

  const scored: SearchResult[] = [];

  const { vectors, chunkIds, dimensions, hnswIndex } = cache;

  if (!vectors || !chunkIds) {
    return [];
  }
  if (hnswIndex) {
    try {
      const { HNSW } = require("hnsw");
      const index = HNSW.fromJSON(hnswIndex);
      // Increased efSearch for better accuracy
      const hnswResults = index.searchKNN(
        queryEmbedding,
        Math.max(topK * 2, 20),
        { efSearch: 64 },
      );

        const chunkById = new Map(chunks.map(c => [c.id, c]));
        const chunkResults: SearchResult[] = [];
        for (const res of hnswResults) {
          const chunkId = chunkIds[res.id];
          const chunk = chunkById.get(chunkId);
          if (chunk) {
            const symbol = chunk.symbol ? symbols[chunk.symbol] : undefined;
            chunkResults.push({ chunk, score: res.score, symbol });
          }
        }

      chunkResults.sort((a, b) => b.score - a.score);
      return chunkResults.slice(0, topK);
    } catch (e) {
      console.warn("HNSW search failed, falling back to exhaustive search:", e);
    }
  }

  // Fallback: Optimized path: binary search over contiguous buffer
  // Map chunkId to index for fast lookup
  const idToIndex = new Map<string, number>();
  chunkIds.forEach((id, i) => idToIndex.set(id, i));

  for (const chunk of chunks) {
    const idx = idToIndex.get(chunk.id);
    if (idx === undefined) continue;

    const score = cosineSimilarityBinary(
      queryEmbedding,
      vectors!,
      idx * dimensions,
      dimensions,
    );
    const symbol = chunk.symbol ? symbols[chunk.symbol] : undefined;
    scored.push({ chunk, score, symbol });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// ─── Symbol Lookup ────────────────────────────────────────────────────────────

/**
 * Direct symbol lookup — bypasses embedding when the query matches a known
 * symbol name. Returns chunks for matched symbols scored by match quality.
 *
 * Match tiers (in order of precedence):
 *   1.0 — exact match: query === symbolName (case-insensitive)
 *   0.95 — single-word match: one word in query === symbolName
 *   0.80 — prefix match: symbolName starts with a query word (or vice versa)
 *
 * Returns [] if no symbol matches (caller should fall through to vector/BM25).
 * Only activates for narrow queries (≤5 matches) to avoid false positives on
 * generic names like "connect" or "init".
 */
export function symbolLookup(
  query: string,
  chunks: Chunk[],
  symbols: SymbolIndex,
): SearchResult[] {
  const q = query.trim().toLowerCase();
  const words = q.split(/[\s\W]+/).filter((w) => w.length >= 2);

  const candidates: Array<{ name: string; score: number }> = [];

  for (const name of Object.keys(symbols)) {
    const lower = name.toLowerCase();
    if (lower === q) {
      candidates.push({ name, score: 1.0 });
    } else if (words.some((w) => lower === w)) {
      candidates.push({ name, score: 0.95 });
    } else if (words.some((w) => lower.startsWith(w) || w.startsWith(lower))) {
      candidates.push({ name, score: 0.8 });
    }
  }

  // Mixed queries like "createEmail parameters thread_id signature" produce a
  // broad candidate set because prose words ("parameters", "signature") match
  // many symbols. Narrow by keeping only candidates matched by identifier-like
  // tokens (camelCase or snake_case), which are the intentional symbol hints.
  let finalCandidates = candidates;
  if (candidates.length > 5) {
    const identTokens = query
      .trim()
      .split(/\s+/)
      .filter((w) => /[A-Z]/.test(w) || (/_/.test(w) && /[a-zA-Z]/.test(w)))
      .map((w) => w.toLowerCase());
    if (identTokens.length > 0) {
      finalCandidates = candidates.filter(({ name }) => {
        const lower = name.toLowerCase();
        return identTokens.some(
          (t) => lower === t || lower.startsWith(t) || t.startsWith(lower),
        );
      });
    }
  }

  if (finalCandidates.length === 0 || finalCandidates.length > 5) return [];

  finalCandidates.sort((a, b) => b.score - a.score);

  const results: SearchResult[] = [];
  for (const { name, score } of finalCandidates) {
    const sym = symbols[name];
    const chunk = chunks.find((c) => c.symbol === name && c.file === sym.file);
    if (chunk) {
      results.push({ chunk, score, symbol: sym });
    }
  }

  return results;
}

// ─── Keyword Search ───────────────────────────────────────────────────────────

/**
 * TF-based keyword search — used as fallback when embeddings are not available.
 *
 * Scores each chunk by term frequency normalized by content length.
 * Not as powerful as semantic search but requires no embedding service.
 */
export function keywordSearch(
  query: string,
  chunks: Chunk[],
  symbols: SymbolIndex,
  topK = 10,
): SearchResult[] {
  // Split query into meaningful terms (skip stop words shorter than 3 chars)
  const terms = query
    .toLowerCase()
    .split(/[\s\W]+/)
    .filter((t) => t.length >= 3);

  if (terms.length === 0) return [];

  const scored: SearchResult[] = chunks.map((chunk) => {
    const content = chunk.content.toLowerCase();
    let score = 0;

    for (const term of terms) {
      // Count occurrences
      let pos = 0;
      let count = 0;
      while ((pos = content.indexOf(term, pos)) !== -1) {
        count++;
        pos += term.length;
      }
      if (count > 0) {
        // TF normalized by content length (log-scaled to dampen large files)
        score += count / Math.log(content.length + 2);
      }
    }

    // Bonus: symbol name matches the query terms
    if (chunk.symbol) {
      const symLower = chunk.symbol.toLowerCase();
      if (terms.some((t) => symLower.includes(t))) {
        score *= 2;
      }
    }

    const symbol = chunk.symbol ? symbols[chunk.symbol] : undefined;
    return { chunk, score, symbol };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.filter((r) => r.score > 0).slice(0, topK);
}

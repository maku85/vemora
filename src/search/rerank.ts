import type { SearchResult } from "../core/types";

// biome-ignore lint/suspicious/noExplicitAny: @xenova/transformers has no exported TS types
let model: any = null;
// biome-ignore lint/suspicious/noExplicitAny: @xenova/transformers has no exported TS types
let tokenizer: any = null;

/**
 * Initializes the reranker model and tokenizer if not already loaded.
 * Model: Xenova/ms-marco-MiniLM-L-6-v2
 *
 * Requires the optional peer dependency `@xenova/transformers`:
 *   npm install @xenova/transformers
 */
async function initReranker() {
  if (!model) {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic optional dependency
    let transformers: any;
    try {
      transformers = require("@xenova/transformers");
    } catch {
      throw new Error(
        "The --rerank flag requires @xenova/transformers.\n" +
          "Install it with: npm install @xenova/transformers",
      );
    }
    const { AutoModelForSequenceClassification, AutoTokenizer } = transformers;
    model = await AutoModelForSequenceClassification.from_pretrained(
      "Xenova/ms-marco-MiniLM-L-6-v2",
      { quantized: false },
    );
    tokenizer = await AutoTokenizer.from_pretrained(
      "Xenova/ms-marco-MiniLM-L-6-v2",
    );
  }
}

/**
 * Re-scores search results using a Cross-Encoder model.
 *
 * A cross-encoder processes the (query, chunk) pair together,
 * capturing deep semantic interactions that cosine similarity
 * (bi-encoder) might miss.
 *
 * @param query The user's natural language query
 * @param results Initial search results (from vector or keyword search)
 * @param topK Number of results to return after reranking
 * @returns Re-scored and sorted search results
 */
export async function rerankResults(
  query: string,
  results: SearchResult[],
  topK: number = 10,
): Promise<SearchResult[]> {
  if (results.length === 0) return [];

  await initReranker();

  const reranked: SearchResult[] = [];

  // We only rerank the first 25 results to keep it fast
  const candidates = results.slice(0, 25);

  for (const res of candidates) {
    try {
      // Tokenize the pair
      const inputs = await tokenizer(query, {
        text_pair: res.chunk.content,
        truncation: true,
        padding: true,
      });

      // Get the raw logits
      const { logits } = await model(inputs);

      // For this model, the logit at index 0 is the relevance score
      const score = logits.data[0];

      reranked.push({
        ...res,
        score: score,
      });
    } catch (err) {
      console.warn(`Failed to rerank chunk ${res.chunk.id}:`, err);
      reranked.push(res);
    }
  }

  // Sort by the new cross-encoder logit (higher is more relevant)
  reranked.sort((a, b) => b.score - a.score);

  return reranked.slice(0, topK);
}

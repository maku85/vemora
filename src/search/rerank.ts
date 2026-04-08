import type { RerankConfig, SearchResult } from "../core/types";
import { OllamaProvider } from "../llm/ollama";

// ─── Xenova cross-encoder (original implementation) ──────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: @xenova/transformers has no exported TS types
let xenovaModel: any = null;
// biome-ignore lint/suspicious/noExplicitAny: @xenova/transformers has no exported TS types
let xenovaTokenizer: any = null;

async function initXenovaReranker() {
  if (!xenovaModel) {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic optional dependency
    let transformers: any;
    try {
      transformers = require("@xenova/transformers");
    } catch {
      throw new Error(
        "The xenova reranker requires @xenova/transformers.\n" +
          "Install it with: npm install @xenova/transformers\n" +
          'Or switch to the ollama reranker: set reranker.provider = "ollama" in .vemora/config.json',
      );
    }
    const { AutoModelForSequenceClassification, AutoTokenizer } = transformers;
    xenovaModel = await AutoModelForSequenceClassification.from_pretrained(
      "Xenova/ms-marco-MiniLM-L-6-v2",
      { quantized: false },
    );
    xenovaTokenizer = await AutoTokenizer.from_pretrained(
      "Xenova/ms-marco-MiniLM-L-6-v2",
    );
  }
}

async function rerankXenova(
  query: string,
  results: SearchResult[],
  topK: number,
): Promise<SearchResult[]> {
  await initXenovaReranker();

  const reranked: SearchResult[] = [];
  const candidates = results.slice(0, 25);

  for (const res of candidates) {
    try {
      const inputs = await xenovaTokenizer(query, {
        text_pair: res.chunk.content,
        truncation: true,
        padding: true,
      });
      const { logits } = await xenovaModel(inputs);
      reranked.push({ ...res, score: logits.data[0] });
    } catch {
      reranked.push(res);
    }
  }

  reranked.sort((a, b) => b.score - a.score);
  return reranked.slice(0, topK);
}

// ─── Ollama LLM reranker ──────────────────────────────────────────────────────

async function rerankOllama(
  query: string,
  results: SearchResult[],
  topK: number,
  config: RerankConfig,
  fallbackModel?: string,
): Promise<SearchResult[]> {
  const candidates = results.slice(0, 25);
  if (candidates.length === 0) return [];

  const model = config.model ?? fallbackModel ?? "gemma4:e4b";
  const ollama = new OllamaProvider(config.baseUrl ?? "http://localhost:11434");

  const chunkList = candidates
    .map((r, i) => {
      const snippet = r.chunk.content.slice(0, 300).replace(/\n/g, " ");
      return `[${i}] ${r.chunk.file}:${r.chunk.start}\n${snippet}`;
    })
    .join("\n\n");

  const prompt =
    `Rank the following code chunks by relevance to the query. ` +
    `Return ONLY a JSON array of 0-based indices, most relevant first. ` +
    `Example for 3 chunks: [2, 0, 1]\n\n` +
    `Query: "${query}"\n\n` +
    `Chunks:\n${chunkList}`;

  try {
    const response = await ollama.chat(
      [{ role: "user", content: prompt }],
      { model, temperature: 0, maxTokens: 100 },
    );

    const raw = response.content.trim();
    // Extract JSON array from response (model may wrap it in prose)
    const match = raw.match(/\[[\d,\s]+\]/);
    if (!match) return results.slice(0, topK);

    const indices: number[] = JSON.parse(match[0]);
    const reranked = indices
      .filter((i) => i >= 0 && i < candidates.length)
      .map((i) => candidates[i]);

    // Append any candidates not mentioned by the model, preserving original order
    const seen = new Set(indices);
    for (let i = 0; i < candidates.length; i++) {
      if (!seen.has(i)) reranked.push(candidates[i]);
    }

    return reranked.slice(0, topK);
  } catch {
    // Graceful fallback: return original order
    return results.slice(0, topK);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Re-scores search results using the configured reranker.
 *
 * @param query       The user's natural language query
 * @param results     Initial search results (from vector or keyword search)
 * @param topK        Number of results to return after reranking
 * @param config      Reranker config (default: xenova cross-encoder)
 * @param fallbackModel  Model name to use when config.model is not set (ollama only)
 */
export async function rerankResults(
  query: string,
  results: SearchResult[],
  topK = 10,
  config?: RerankConfig,
  fallbackModel?: string,
): Promise<SearchResult[]> {
  if (results.length === 0) return [];

  const provider = config?.provider ?? "xenova";

  if (provider === "none") {
    return results.slice(0, topK);
  }

  if (provider === "ollama") {
    return rerankOllama(query, results, topK, config!, fallbackModel);
  }

  // Default: xenova
  return rerankXenova(query, results, topK);
}

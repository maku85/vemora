// ─── Project Configuration ────────────────────────────────────────────────────

export interface DisplayConfig {
  /**
   * Default output format for query/context/ask commands.
   * Set to "terse" for small/local models with limited context windows.
   * Can always be overridden per-command with --format.
   */
  format?: "terse" | "markdown";
}

export interface AiMemoryConfig {
  /** Deterministic project ID derived from root directory path */
  projectId: string;
  projectName: string;
  /** Schema version of this config file */
  version: string;
  /** Absolute path to project root (injected at load time, not persisted) */
  rootDir: string;
  /** fast-glob patterns of files to include */
  include: string[];
  /** fast-glob patterns to exclude (node_modules, build outputs, etc.) */
  exclude: string[];
  /** Max lines per chunk before splitting */
  maxChunkLines: number;
  /** Max characters per chunk before splitting */
  maxChunkChars: number;
  embedding: EmbeddingConfig;
  /** Configuration for LLM-based summarization (vemora summarize) */
  summarization?: SummarizationConfig;
  /** Output display preferences */
  display?: DisplayConfig;
  /** Human-readable description of where the local cache lives */
  cacheDir: string;
}

export interface SummarizationConfig {
  provider: "openai" | "anthropic" | "ollama";
  /** Chat completion model (default: gpt-4o-mini) */
  model: string;
  /** API key. Defaults to OPENAI_API_KEY / ANTHROPIC_API_KEY env vars. */
  apiKey?: string;
  /** Base URL for OpenAI-compatible or Ollama APIs */
  baseUrl?: string;
}

export interface EmbeddingConfig {
  provider: "openai" | "ollama" | "none";
  model: string;
  /** Vector dimensions — must match the model output */
  dimensions: number;
  /** API key for OpenAI. Defaults to OPENAI_API_KEY env var. */
  apiKey?: string;
  /** Base URL for Ollama. Defaults to http://localhost:11434 */
  baseUrl?: string;
}

// ─── Repository Index (versioned in git) ─────────────────────────────────────

/**
 * files.json — top-level map from relative file path to its index entry.
 * Hash-based change detection enables incremental re-indexing.
 */
export interface FileIndex {
  [relativePath: string]: FileEntry;
}

export interface FileEntry {
  /** SHA-256 hash of file content for change detection */
  hash: string;
  size: number;
  lastModified: string;
  /** IDs of all chunks extracted from this file */
  chunks: string[];
  /** Names of all symbols extracted from this file */
  symbols: string[];
}

/**
 * chunks.json — array of code chunks extracted from the repository.
 * Each chunk is a semantically meaningful slice (function, class, etc.)
 * sized to fit in an LLM context window.
 */
export interface Chunk {
  /** Content-hash based ID. Stable across re-indexing if code doesn't change. */
  id: string;
  /** Relative file path */
  file: string;
  /** 1-based start line (inclusive) */
  start: number;
  /** 1-based end line (inclusive) */
  end: number;
  /** Symbol this chunk belongs to, if any */
  symbol?: string;
  /** The raw source text */
  content: string;
}

/**
 * symbols.json — map from symbol name to its location and metadata.
 * Used for symbol-level navigation after a vector search.
 */
export interface SymbolIndex {
  [name: string]: SymbolEntry;
}

export interface SymbolEntry {
  type:
    | "function"
    | "class"
    | "method"
    | "interface"
    | "type"
    | "constant"
    | "variable";
  /** Relative file path */
  file: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  /** For methods: the parent class name */
  parent?: string;
}

// ─── Dependency Graph (versioned in git) ─────────────────────────────────────

/**
 * deps.json — maps each file to the project-internal files it imports.
 *
 * Only tracks intra-project imports (relative paths that resolve to files
 * in the index). npm packages are ignored.
 *
 * Stored in git so the whole team shares the same graph without rebuilding.
 */
export interface DependencyGraph {
  [relativePath: string]: FileDependencies;
}

export interface FileDependencies {
  /** Project files this file imports from */
  imports: ImportEntry[];
}

export interface ImportEntry {
  /** Relative path of the imported file (within the project) */
  file: string;
  /** Named symbols imported. Empty = default / namespace / side-effect import. */
  symbols: string[];
}

export interface CallGraphEntry {
  /** The function/method name that is being called */
  name: string;
  /** The file containing the definition, if known */
  file?: string;
  /** Location in the file */
  line?: number;
}

export interface CallGraph {
  /** Map from function/method ID (file:symbol) to call info */
  [callerId: string]: {
    calls: CallGraphEntry[];
    calledBy: string[]; // List of caller IDs
  };
}

// ─── Metadata ─────────────────────────────────────────────────────────────────

export interface Metadata {
  projectId: string;
  projectName: string;
  lastIndexed: string | null;
  indexedFiles: number;
  totalChunks: number;
  totalSymbols: number;
  totalDepEdges: number;
  totalCallEdges?: number; // Total number of calls tracked
  /** Files with AI-generated summaries (from vemora summarize) */
  totalSummaries?: number;
  embeddingProvider?: string;
  embeddingModel?: string;
}

// ─── Summaries (versioned in git) ─────────────────────────────────────────────

/**
 * .vemora/summaries/file-summaries.json
 * LLM-generated 2-3 sentence descriptions per file.
 * Generated by `vemora summarize`. Committed to git so the whole team shares them.
 * Incremental: only regenerates entries whose content hash changed.
 */
export interface FileSummaryIndex {
  [relativePath: string]: FileSummary;
}

export interface FileSummary {
  /** 2-3 sentence description of the file's purpose and key exports */
  summary: string;
  /** SHA-256 hash of the file content at generation time (for incremental updates) */
  contentHash: string;
  /** ISO timestamp */
  generatedAt: string;
}

/**
 * .vemora/summaries/project-summary.json
 * LLM-generated ~400-500 word project overview synthesized from all file summaries.
 * Intended to be a stable "always-available" context document for LLMs.
 */
export interface ProjectSummary {
  /** High-level overview of the project's purpose, architecture, and components */
  overview: string;
  generatedAt: string;
}

// ─── Local Embedding Cache (NOT versioned in git) ────────────────────────────

/**
 * Stored in ~/.vemora-cache/<projectId>/embeddings.json.
 * Never committed to git — each developer maintains their own local cache.
 *
 * Design: chunk IDs are content-hash based, so embeddings are reusable
 * across branches as long as the code content doesn't change.
 */
export interface EmbeddingCache {
  projectId: string;
  embeddingModel: string;
  dimensions: number;
  lastUpdated: string;
  /** Map from chunk ID to its embedding vector (legacy JSON format) */
  embeddings?: Record<string, number[]>;
  /** Optimized: contiguous buffer of all vectors (runtime only) */
  vectors?: Float32Array; // Optimized binary format (dims * count)
  /** Optimized: ordered list of chunk IDs matching the vectors buffer */
  chunkIds?: string[]; // Maps index in vectors buffer to chunk ID
  hnswIndex?: unknown; // Serialized HNSW index for fast search
}

// ─── Knowledge Store (versioned in git) ──────────────────────────────────────

/**
 * .vemora/knowledge/entries.json
 * Human- or LLM-authored notes about the project that the structural index
 * cannot capture: architectural decisions, approved patterns, gotchas, glossary.
 * Committed to git so the whole team (and future LLM sessions) benefit.
 */
export interface KnowledgeEntry {
  /** UUID v4 */
  id: string;
  category: "decision" | "pattern" | "gotcha" | "glossary";
  /** Short title shown in context headers */
  title: string;
  /** Free-form text, searchable via keyword overlap */
  body: string;
  /** Project-relative file paths this entry is about */
  relatedFiles?: string[];
  /** SHA-256 hashes of relatedFiles at creation time, keyed by path */
  relatedFileHashes?: Record<string, string>;
  /** Symbol names this entry is about */
  relatedSymbols?: string[];
  /** ISO timestamp */
  createdAt: string;
  /** "human" or "llm:<model-id>" */
  createdBy: string;
  confidence: "high" | "medium" | "low";
  /** ID of the entry this supersedes (for updates) */
  supersedes?: string;
}

// ─── TODO Annotations ─────────────────────────────────────────────────────────

export interface TodoAnnotation {
  file: string;
  /** 1-based line number */
  line: number;
  type: "TODO" | "FIXME" | "HACK" | "XXX";
  text: string;
}

// ─── Search Results ───────────────────────────────────────────────────────────

export interface SearchResult {
  chunk: Chunk;
  /** Cosine similarity score in [0, 1] (or keyword score for non-vector search) */
  score: number;
  /** Resolved symbol info if the chunk has a symbol */
  symbol?: SymbolEntry;
}

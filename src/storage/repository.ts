import fs from "fs";
import path from "path";
import {
  AI_MEMORY_DIR,
  CALLGRAPH_JSON,
  CHUNKS_JSON,
  DEPS_JSON,
  FILES_JSON,
  INDEX_DIR,
  METADATA_FILE,
  SYMBOLS_JSON,
  TODOS_JSON,
} from "../core/config";
import type {
  CallGraph,
  Chunk,
  DependencyGraph,
  FileIndex,
  Metadata,
  SymbolIndex,
  TodoAnnotation,
} from "../core/types";

/**
 * Reads and writes the versioned repository memory files stored in .vemora/.
 * All files here are committed to git so collaborators share the same index.
 */
export class RepositoryStorage {
  private memoryDir: string;
  private indexDir: string;

  constructor(rootDir: string) {
    this.memoryDir = path.join(rootDir, AI_MEMORY_DIR);
    this.indexDir = path.join(this.memoryDir, INDEX_DIR);
  }

  // ─── Files Index ────────────────────────────────────────────────────────────

  loadFiles(): FileIndex {
    return this.readJson<FileIndex>(path.join(this.indexDir, FILES_JSON), {});
  }

  saveFiles(index: FileIndex): void {
    this.writeJson(path.join(this.indexDir, FILES_JSON), index);
  }

  // ─── Chunks ─────────────────────────────────────────────────────────────────

  loadChunks(): Chunk[] {
    return this.readJson<Chunk[]>(path.join(this.indexDir, CHUNKS_JSON), []);
  }

  saveChunks(chunks: Chunk[]): void {
    this.writeJson(path.join(this.indexDir, CHUNKS_JSON), chunks);
  }

  // ─── Symbol Index ────────────────────────────────────────────────────────────

  loadSymbols(): SymbolIndex {
    return this.readJson<SymbolIndex>(
      path.join(this.indexDir, SYMBOLS_JSON),
      {},
    );
  }

  saveSymbols(symbols: SymbolIndex): void {
    this.writeJson(path.join(this.indexDir, SYMBOLS_JSON), symbols);
  }

  // ─── Dependency Graph ────────────────────────────────────────────────────────

  loadDeps(): DependencyGraph {
    return this.readJson<DependencyGraph>(
      path.join(this.indexDir, DEPS_JSON),
      {},
    );
  }

  saveDeps(graph: DependencyGraph): void {
    this.writeJson(path.join(this.indexDir, DEPS_JSON), graph);
  }

  // ─── Call Graph ──────────────────────────────────────────────────────────────

  loadCallGraph(): CallGraph {
    return this.readJson<CallGraph>(
      path.join(this.indexDir, CALLGRAPH_JSON),
      {},
    );
  }

  saveCallGraph(graph: CallGraph): void {
    this.writeJson(path.join(this.indexDir, CALLGRAPH_JSON), graph);
  }

  // ─── TODO Annotations ────────────────────────────────────────────────────────

  loadTodos(): TodoAnnotation[] {
    return this.readJson<TodoAnnotation[]>(
      path.join(this.indexDir, TODOS_JSON),
      [],
    );
  }

  saveTodos(todos: TodoAnnotation[]): void {
    this.writeJson(path.join(this.indexDir, TODOS_JSON), todos);
  }

  // ─── Metadata ────────────────────────────────────────────────────────────────

  loadMetadata(): Metadata | null {
    const p = path.join(this.memoryDir, METADATA_FILE);
    if (!fs.existsSync(p)) return null;
    return this.readJson<Metadata>(p, null as unknown as Metadata);
  }

  saveMetadata(meta: Metadata): void {
    this.writeJson(path.join(this.memoryDir, METADATA_FILE), meta);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private readJson<T>(filePath: string, fallback: T): T {
    if (!fs.existsSync(filePath)) return fallback;
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
    } catch {
      return fallback;
    }
  }

  private writeJson(filePath: string, data: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  }
}

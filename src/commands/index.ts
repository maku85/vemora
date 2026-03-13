import chalk from "chalk";
import fs from "fs";
import ora from "ora";
import path from "path";
import { loadConfig } from "../core/config";
import type {
  AiMemoryConfig,
  CallGraph,
  Chunk,
  DependencyGraph,
  EmbeddingCache,
  FileIndex,
  Metadata,
  SymbolIndex,
} from "../core/types";
import { createEmbeddingProvider } from "../embeddings/factory";
import { buildGlobalCallGraph, extractFileCalls } from "../indexer/callgraph";
import { chunkFile } from "../indexer/chunker";
import {
  graphStats,
  loadTsPathAliases,
  updateDependencyGraph,
} from "../indexer/deps";
import { hashFile } from "../indexer/hasher";
import { buildSymbolIndex, parseSymbols } from "../indexer/parser";
import { scanRepository } from "../indexer/scanner";
import { EmbeddingCacheStorage } from "../storage/cache";
import { RepositoryStorage } from "../storage/repository";


export interface IndexOptions {
  /** Re-index all files, ignoring existing hashes */
  force?: boolean;
  /** Skip embedding generation (index only) */
  noEmbed?: boolean;
  /** Watch for changes and re-index automatically */
  watch?: boolean;
}

export async function runIndex(
  rootDir: string,
  options: IndexOptions = {},
): Promise<void> {
  const config = loadConfig(rootDir);
  const repo = new RepositoryStorage(rootDir);
  const cacheStorage = new EmbeddingCacheStorage(config.projectId);

  console.log(chalk.bold(`Indexing ${chalk.cyan(config.projectName)}...`));
  console.log();

  // ── Step 0: Initial full or incremental index ───────────────────────────────
  const {
    newFiles,
    newChunks,
    newSymbols,
    newDeps,
    newCallGraph,
    stats,
    changedPaths,
    deletedPaths,
  } = await performIndexIteration(rootDir, config, repo, options);

  if (changedPaths.length > 0 || deletedPaths.length > 0) {
    // Save everything from the initial run
    repo.saveFiles(newFiles);
    repo.saveChunks(newChunks);
    repo.saveSymbols(newSymbols);
    repo.saveDeps(newDeps);
    repo.saveCallGraph(newCallGraph);

    if (!options.noEmbed && config.embedding.provider !== "none") {
      const cache = await generateEmbeddings(
        newChunks,
        cacheStorage.load(),
        config,
        cacheStorage,
      );
      await rebuildHNSWIndex(newChunks, cache, cacheStorage);
    }

    updateMetadata(repo, config, newFiles, newSymbols, stats, newCallGraph);
    console.log(chalk.bold.green("\nInitial indexing complete!"));
  } else {
    console.log(chalk.green("Index is already up to date."));
  }

  // ── Step 1: Start watcher if requested ──────────────────────────────────────
  if (options.watch) {
    await startWatcher(rootDir, config, repo, cacheStorage, options);
  }
}

/**
 * Performs a single pass of indexing (scan, hash, parse, deps).
 * Returns the new state and which paths were affected.
 */
async function performIndexIteration(
  rootDir: string,
  config: AiMemoryConfig,
  repo: RepositoryStorage,
  options: IndexOptions,
  specificPaths?: { changed?: string[]; deleted?: string[] },
) {
  // Load previous state
  const prevFiles: FileIndex = options.force ? {} : repo.loadFiles();
  const prevChunks: Chunk[] = options.force ? [] : repo.loadChunks();
  const prevSymbols: SymbolIndex = options.force ? {} : repo.loadSymbols();
  const prevDeps: DependencyGraph = options.force ? {} : repo.loadDeps();
  const prevCallGraph: CallGraph = options.force ? {} : repo.loadCallGraph();

  let changedPaths: string[] = [];
  let deletedPaths: string[] = [];
  let unchangedPaths: string[] = [];

  if (specificPaths) {
    // If called from watcher, we already know what changed
    changedPaths = specificPaths.changed ?? [];
    deletedPaths = specificPaths.deleted ?? [];
    // Carry forward everything else from prevFiles
    const affected = new Set([...changedPaths, ...deletedPaths]);
    unchangedPaths = Object.keys(prevFiles).filter((p) => !affected.has(p));
  } else {
    // Standard run: scan everything
    const scanSpinner = ora("Scanning repository files...").start();
    const scanned = await scanRepository(config);
    scanSpinner.succeed(
      `Found ${chalk.bold(scanned.length)} files to consider`,
    );

    const hashSpinner = ora("Computing file hashes...").start();
    const scannedPaths = new Set<string>();

    for (const file of scanned) {
      scannedPaths.add(file.relativePath);
      try {
        const hash = hashFile(file.absolutePath);
        const prev = prevFiles[file.relativePath];
        if (prev && prev.hash === hash && !options.force) {
          unchangedPaths.push(file.relativePath);
        } else {
          changedPaths.push(file.relativePath);
        }
      } catch {
        /* skip */
      }
    }

    deletedPaths = Object.keys(prevFiles).filter((p) => !scannedPaths.has(p));

    hashSpinner.succeed(
      [
        chalk.green(`${unchangedPaths.length} unchanged`),
        chalk.yellow(`${changedPaths.length} changed/new`),
        deletedPaths.length > 0
          ? chalk.red(`${deletedPaths.length} deleted`)
          : null,
      ]
        .filter(Boolean)
        .join(", "),
    );
  }

  const newFiles: FileIndex = {};
  // Carry forward unchanged
  for (const p of unchangedPaths) {
    if (prevFiles[p]) newFiles[p] = prevFiles[p];
  }
  const allFilePaths = new Set(Object.keys(newFiles));

  const reprocessPaths = new Set([...changedPaths, ...deletedPaths]);
  const newSymbols: SymbolIndex = Object.fromEntries(
    Object.entries(prevSymbols).filter(
      ([, sym]) => !reprocessPaths.has(sym.file),
    ),
  );
  const newChunks: Chunk[] = prevChunks.filter(
    (c) => !reprocessPaths.has(c.file),
  );

  // Call Graph partials
  const partialCallGraphs: CallGraph[] = [];
  // Carry forward partial call graphs for unchanged files
  // (This is a simplified approach: we filter the old global graph)
  const unchangedCallGraph: CallGraph = {};
  for (const [callerId, data] of Object.entries(prevCallGraph)) {
    const file = callerId.split(":")[0];
    if (reprocessPaths.has(file)) continue;
    unchangedCallGraph[callerId] = data;
  }
  partialCallGraphs.push(unchangedCallGraph);

  const changedContents = new Map<string, string>();
  if (changedPaths.length > 0) {
    const parseSpinner = ora(`Parsing ${changedPaths.length} files...`).start();
    let _parseErrors = 0;

    for (const relativePath of changedPaths) {
      const absolutePath = path.join(rootDir, relativePath);
      try {
        if (!fs.existsSync(absolutePath)) continue;
        const content = fs.readFileSync(absolutePath, "utf-8");
        const hash = hashFile(absolutePath);
        const stats = fs.statSync(absolutePath);

        const symbols = parseSymbols(relativePath, content);
        const chunks = chunkFile(relativePath, content, symbols, config);
        const fileSymbols = buildSymbolIndex(relativePath, symbols);

        newFiles[relativePath] = {
          hash,
          size: stats.size,
          lastModified: stats.mtime.toISOString(),
          chunks: chunks.map((c) => c.id),
          symbols: symbols.map((s) => s.name),
        };

        Object.assign(newSymbols, fileSymbols);
        newChunks.push(...chunks);
        changedContents.set(relativePath, content);

        // Extract calls for Call Graph
        const fileCalls = extractFileCalls(relativePath, content, {
          symbols: newSymbols, // Use symbols extracted so far
          deps: prevDeps, // Use previous deps for resolution during extraction
          allFiles: allFilePaths, // Temporary placeholder, will refine later
        });
        partialCallGraphs.push(fileCalls);
      } catch (_err) {
        _parseErrors++;
      }
    }
    parseSpinner.succeed(`Parsed ${changedPaths.length} files`);
  }

  const aliases = loadTsPathAliases(rootDir);
  const newDeps = updateDependencyGraph(
    prevDeps,
    changedContents,
    new Set(deletedPaths),
    allFilePaths,
    aliases,
  );
  const stats = graphStats(newDeps);

  // Build final Call Graph
  const newCallGraph = buildGlobalCallGraph(partialCallGraphs);

  return {
    newFiles,
    newChunks,
    newSymbols,
    newDeps,
    newCallGraph,
    stats,
    changedPaths,
    deletedPaths,
  };
}

function updateMetadata(
  repo: RepositoryStorage,
  config: AiMemoryConfig,
  files: FileIndex,
  symbols: SymbolIndex,
  stats: {
    totalFiles: number;
    totalEdges: number;
    mostImported: Array<{ file: string; count: number }>;
  },
  callGraph?: CallGraph,
) {
  let totalCallEdges = 0;
  if (callGraph) {
    totalCallEdges = Object.values(callGraph).reduce(
      (acc, data) => acc + data.calls.length,
      0,
    );
  }

  const meta: Metadata = {
    projectId: config.projectId,
    projectName: config.projectName,
    lastIndexed: new Date().toISOString(),
    indexedFiles: Object.keys(files).length,
    totalChunks: Object.values(files).reduce(
      (acc, f) => acc + f.chunks.length,
      0,
    ),
    totalSymbols: Object.keys(symbols).length,
    totalDepEdges: stats.totalEdges,
    totalCallEdges,
    embeddingProvider: config.embedding.provider,
    embeddingModel: config.embedding.model,
  };
  repo.saveMetadata(meta);
  return meta;
}

async function startWatcher(
  rootDir: string,
  config: AiMemoryConfig,
  repo: RepositoryStorage,
  cacheStorage: EmbeddingCacheStorage,
  options: IndexOptions,
) {
  const chokidar = require("chokidar");
  // micromatch is a transitive dependency of fast-glob — always available
  const micromatch = require("micromatch");

  // Use a function so that chokidar filters against relative paths the same way
  // the scanner does, preventing dist/ and .ai-memory/ writes from feedback-looping.
  const isIgnored = (absPath: string): boolean => {
    const rel = path.relative(rootDir, absPath);
    if (!rel || rel.startsWith("..")) return false;
    return micromatch.isMatch(rel, config.exclude, { dot: true });
  };

  const watcher = chokidar.watch(rootDir, {
    ignored: isIgnored,
    persistent: true,
    ignoreInitial: true,
  });

  console.log(chalk.blue("\nWatching for changes... (Ctrl+C to stop)"));

  const pendingChanges = new Set<string>();
  const pendingDeletions = new Set<string>();
  let debounceTimer: NodeJS.Timeout | null = null;

  const triggerIndex = async () => {
    const changed = Array.from(pendingChanges);
    const deleted = Array.from(pendingDeletions);
    pendingChanges.clear();
    pendingDeletions.clear();

    process.stdout.write(
      chalk.yellow(
        `\nChange detected, re-indexing ${changed.length + deleted.length} files... `,
      ),
    );

    try {
      const { newFiles, newChunks, newSymbols, newDeps, newCallGraph, stats } =
        await performIndexIteration(rootDir, config, repo, options, {
          changed,
          deleted,
        });

      repo.saveFiles(newFiles);
      repo.saveChunks(newChunks);
      repo.saveSymbols(newSymbols);
      repo.saveDeps(newDeps);
      repo.saveCallGraph(newCallGraph);

      if (!options.noEmbed && config.embedding.provider !== "none") {
        const cache = cacheStorage.load();
        const updatedCache = await generateEmbeddings(
          newChunks,
          cache,
          config,
          cacheStorage,
        );
        await rebuildHNSWIndex(newChunks, updatedCache, cacheStorage);
      }

      updateMetadata(repo, config, newFiles, newSymbols, stats, newCallGraph);
      process.stdout.write(chalk.green("Done.\n"));
    } catch (err) {
      process.stdout.write(chalk.red(`Failed: ${(err as Error).message}\n`));
    }
  };

  const handleChange = (filePath: string, isDeleted = false) => {
    const rel = path.relative(rootDir, filePath);
    if (!rel || rel.startsWith("..")) return;

    // Apply the same include/exclude rules as the scanner to avoid processing
    // files like compiled dist/ output or editor temp files.
    const included = micromatch.isMatch(rel, config.include, { dot: false });
    const excluded = micromatch.isMatch(rel, config.exclude, { dot: true });
    if (!included || excluded) return;

    if (isDeleted) {
      pendingDeletions.add(rel);
      pendingChanges.delete(rel);
    } else {
      pendingChanges.add(rel);
      pendingDeletions.delete(rel);
    }

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(triggerIndex, 500);
  };

  watcher
    .on("add", (p: string) => handleChange(p))
    .on("change", (p: string) => handleChange(p))
    .on("unlink", (p: string) => handleChange(p, true));

  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentionally empty — keeps the process alive
  return new Promise(() => {}); // Keep alive
}

// ─── Embedding Generation ─────────────────────────────────────────────────────

async function generateEmbeddings(
  chunks: Chunk[],
  prevCache: EmbeddingCache | null,
  config: AiMemoryConfig,
  cacheStorage: EmbeddingCacheStorage,
): Promise<EmbeddingCache> {
  const cachedIds = new Set([
    ...Object.keys(prevCache?.embeddings ?? {}),
    ...(prevCache?.chunkIds ?? []),
  ]);
  const toEmbed = chunks.filter((c) => !cachedIds.has(c.id));

  if (toEmbed.length === 0) {
    console.log(chalk.green("✓") + " All embeddings already cached");
    return prevCache!;
  }

  const spinner = ora(
    `Generating embeddings for ${chalk.bold(toEmbed.length)} new chunks via ${config.embedding.provider}...`,
  ).start();

  try {
    const provider = createEmbeddingProvider(config.embedding);

    // Prefix each chunk with its location so the embedding captures context
    const texts = toEmbed.map(
      (c) => `file: ${c.file}\nsymbol: ${c.symbol ?? "(none)"}\n\n${c.content}`,
    );

    const embeddings = await provider.embed(texts);

    const newEmbeddings: Record<string, number[]> = {};
    for (let i = 0; i < toEmbed.length; i++) {
      if (embeddings[i]?.length > 0) {
        newEmbeddings[toEmbed[i].id] = embeddings[i];
      }
    }

    // Build or update the cache
    const baseCache: EmbeddingCache = prevCache ?? {
      projectId: config.projectId,
      embeddingModel: config.embedding.model,
      dimensions: config.embedding.dimensions,
      lastUpdated: new Date().toISOString(),
      embeddings: {},
    };

    // Prune stale entries, then add new ones
    const validIds = new Set(chunks.map((c) => c.id));
    const pruned = cacheStorage.prune(validIds, baseCache);
    const updated = cacheStorage.update(newEmbeddings, pruned);

    spinner.succeed(
      `Generated ${chalk.bold(Object.keys(newEmbeddings).length)} embeddings` +
        ` (cached locally at ~/.ai-memory-cache/)`,
    );

    return updated;
  } catch (err) {
    spinner.fail(`Embedding generation failed: ${(err as Error).message}`);
    console.log(
      chalk.gray(
        "  Keyword search is still available. Fix the provider config and re-run.",
      ),
    );
    return prevCache!;
  }
}

async function rebuildHNSWIndex(
  chunks: Chunk[],
  cache: EmbeddingCache | null,
  cacheStorage: EmbeddingCacheStorage,
): Promise<void> {
  if (!cache || !cache.vectors || !cache.chunkIds) return;

  const spinner = ora("Building HNSW search index...").start();
  try {
    const { HNSW } = require("hnsw");

    // Create new index
    // Using default parameters: M=16, efConstruction=200
    const dimensions = cache.dimensions;
    const index = new HNSW(16, 200, dimensions, "cosine");

    const data = cache.chunkIds.map((id, i) => {
      const offset = i * dimensions;
      const vector = cache.vectors!.subarray(offset, offset + dimensions);
      return { id: i, vector: Array.from(vector) };
    });

    await index.buildIndex(data);

    // Save to cache
    cache.hnswIndex = index.toJSON();
    cacheStorage.save(cache);

    spinner.succeed(
      `HNSW index built with ${chalk.bold(cache.chunkIds.length)} vectors`,
    );
  } catch (err) {
    spinner.fail(`HNSW index build failed: ${(err as Error).message}`);
  }
}

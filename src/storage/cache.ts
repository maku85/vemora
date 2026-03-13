import fs from "fs";
import os from "os";
import path from "path";
import type { EmbeddingCache } from "../core/types";

/** Maximum allowed size for embeddings.bin (512 MB) */
const MAX_CACHE_BYTES = 512 * 1024 * 1024;

/**
 * Manages the local per-developer embedding cache.
 *
 * Stored in ~/.vemora-cache/<projectId>/ — never in the repo.
 * Each developer builds their own cache after running `vemora index`.
 *
 * Design choice: dual-file storage per project.
 * Metadata and chunk IDs are stored in JSON (inspectable).
 * Vectors are stored as a contiguous Float32Array binary buffer (fast I/O).
 * The HNSW index is serialized to a separate JSON file for O(log N) search.
 */
export class EmbeddingCacheStorage {
  private cacheDir: string;
  private cachePath: string; // embeddings.json (metadata + chunkIds)
  private binPath: string; // embeddings.bin (raw floats)
  private hnswPath: string; // embeddings.hnsw.json (serialized HNSW)

  constructor(projectId: string) {
    this.cacheDir = path.join(os.homedir(), ".vemora-cache", projectId);
    this.cachePath = path.join(this.cacheDir, "embeddings.json");
    this.binPath = path.join(this.cacheDir, "embeddings.bin");
    this.hnswPath = path.join(this.cacheDir, "embeddings.hnsw.json");
  }

  load(): EmbeddingCache | null {
    if (!fs.existsSync(this.cachePath)) return null;

    try {
      const metadata = JSON.parse(fs.readFileSync(this.cachePath, "utf-8"));

      // Check if it's the legacy format (embeddings object instead of chunkIds list)
      if (metadata.embeddings && !metadata.chunkIds) {
        console.log("Migrating legacy JSON cache to binary format...");
        this.save(metadata as EmbeddingCache);
        return this.load(); // reload so vectors are read from the binary file
      }

      // New format: load metadata + binary vectors
      if (!fs.existsSync(this.binPath)) return metadata;

      const { size } = fs.statSync(this.binPath);
      if (size > MAX_CACHE_BYTES) {
        throw new Error(`Cache file too large (${size} bytes): ${this.binPath}`);
      }
      const binBuffer = fs.readFileSync(this.binPath);
      // Slice to a fresh ArrayBuffer to guarantee 4-byte alignment regardless
      // of Node.js buffer pool offsets (avoids RangeError on misaligned views).
      const ab = binBuffer.buffer.slice(
        binBuffer.byteOffset,
        binBuffer.byteOffset + binBuffer.byteLength,
      );
      const vectors = new Float32Array(ab);

      // Load HNSW index if it exists
      let hnswIndex = undefined;
      if (fs.existsSync(this.hnswPath)) {
        try {
          hnswIndex = JSON.parse(fs.readFileSync(this.hnswPath, "utf-8"));
        } catch (_e) {
          console.warn(
            "Failed to load HNSW index, it will be rebuilt on next index run.",
          );
        }
      }

      return {
        ...metadata,
        vectors,
        hnswIndex,
      };
    } catch (err) {
      console.error(`Failed to load cache from ${this.cachePath}:`, err);
      return null;
    }
  }

  save(cache: EmbeddingCache): void {
    fs.mkdirSync(this.cacheDir, { recursive: true });

    // If we have standard embeddings record, convert to binary
    if (cache.embeddings && Object.keys(cache.embeddings).length > 0) {
      const chunkIds = Object.keys(cache.embeddings);
      const dims = cache.dimensions;
      const vectors = new Float32Array(chunkIds.length * dims);

      chunkIds.forEach((id, i) => {
        const embedding = cache.embeddings![id];
        vectors.set(embedding, i * dims);
      });

      cache.chunkIds = chunkIds;
      cache.vectors = vectors;
    }

    // Save metadata (exclude actual vectors/embeddings)
    const { vectors, embeddings, ...metadata } = cache;
    fs.writeFileSync(
      this.cachePath,
      JSON.stringify(metadata, null, 2),
      "utf-8",
    );

    // Save binary vectors
    if (vectors) {
      fs.writeFileSync(
        this.binPath,
        Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength),
      );
    }

    // Save HNSW index
    if (cache.hnswIndex) {
      fs.writeFileSync(this.hnswPath, JSON.stringify(cache.hnswIndex), "utf-8");
    }
  }

  update(
    newEmbeddings: Record<string, number[]>,
    cache: EmbeddingCache,
  ): EmbeddingCache {
    // Merge into legacy format first for simplicity, then save (which converts to bin)
    const currentEmbeddings = this.getEmbeddingsMap(cache);
    const updated: EmbeddingCache = {
      ...cache,
      embeddings: { ...currentEmbeddings, ...newEmbeddings },
      lastUpdated: new Date().toISOString(),
    };
    this.save(updated);
    return updated;
  }

  prune(validChunkIds: Set<string>, cache: EmbeddingCache): EmbeddingCache {
    const currentMap = this.getEmbeddingsMap(cache);
    const prunedMap: Record<string, number[]> = {};

    for (const id of validChunkIds) {
      if (currentMap[id]) {
        prunedMap[id] = currentMap[id];
      }
    }

    const updated: EmbeddingCache = {
      ...cache,
      embeddings: prunedMap,
      lastUpdated: new Date().toISOString(),
    };

    // Clear optimized fields to force re-generation from the pruned map
    delete updated.vectors;
    delete updated.chunkIds;

    this.save(updated);
    return updated;
  }

  /**
   * Helper to always get a Map, regardless of storage format
   */
  private getEmbeddingsMap(cache: EmbeddingCache): Record<string, number[]> {
    if (cache.embeddings) return cache.embeddings;
    if (cache.vectors && cache.chunkIds) {
      const map: Record<string, number[]> = {};
      const dims = cache.dimensions;
      cache.chunkIds.forEach((id, i) => {
        map[id] = Array.from(cache.vectors!.subarray(i * dims, (i + 1) * dims));
      });
      return map;
    }
    return {};
  }

  getCacheDir(): string {
    return this.cacheDir;
  }
}

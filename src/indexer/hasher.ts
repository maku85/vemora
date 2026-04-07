import crypto from "crypto";
import fs from "fs";

/**
 * Computes the SHA-256 hash of a file's content.
 * Used for change detection during incremental indexing.
 */
export function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Same hash as hashFile but computed from already-read content.
 * Use this when the file has already been read to avoid a redundant I/O call.
 */
export function hashBuffer(content: Buffer | string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Computes a short content-based hash for a chunk.
 * Using content (not path+line) means embeddings are reusable across branches
 * when the actual code hasn't changed, even if surrounding lines shifted.
 */
export function hashContent(content: string): string {
  return crypto
    .createHash("sha256")
    .update(content, "utf-8")
    .digest("hex")
    .slice(0, 16);
}

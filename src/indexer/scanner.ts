import fg from "fast-glob";
import path from "path";
import type { AiMemoryConfig } from "../core/types";

export interface ScannedFile {
  absolutePath: string;
  relativePath: string;
  /** Lowercase extension without leading dot */
  extension: string;
}

/**
 * Scans the repository using fast-glob and returns all files that match
 * the include/exclude patterns from config.
 *
 * fast-glob is used over native fs.readdir because:
 *  - it natively supports .gitignore-style ignore patterns
 *  - it handles symlinks, hidden files, and large repos efficiently
 *  - it's significantly faster than recursive readdir
 */
export async function scanRepository(
  config: AiMemoryConfig,
): Promise<ScannedFile[]> {
  const entries = await fg(config.include, {
    cwd: config.rootDir,
    ignore: config.exclude,
    dot: false,
    absolute: false,
    followSymbolicLinks: false,
    onlyFiles: true,
    // Return in consistent order for reproducible hashing
    caseSensitiveMatch: true,
  });

  return entries
    .sort() // reproducible order across machines
    .map((relativePath) => ({
      absolutePath: path.join(config.rootDir, relativePath),
      relativePath,
      extension: path.extname(relativePath).slice(1).toLowerCase(),
    }));
}

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { AiMemoryConfig } from "./types";

// ─── Path Constants ────────────────────────────────────────────────────────────

export const AI_MEMORY_DIR = ".vemora";
export const AI_MEMORY_CACHE_DIR = ".vemora-cache";
export const CONFIG_FILE = "config.json";
export const METADATA_FILE = "metadata.json";
export const INDEX_DIR = "index";
export const FILES_JSON = "files.json";
export const CHUNKS_JSON = "chunks.json";
export const SYMBOLS_JSON = "symbols.json";
export const DEPS_JSON = "deps.json";
export const CALLGRAPH_JSON = "callgraph.json";
export const TODOS_JSON = "todos.json";
export const SUMMARIES_DIR = "summaries";
export const FILE_SUMMARIES_JSON = "file-summaries.json";
export const PROJECT_SUMMARY_JSON = "project-summary.json";
export const KNOWLEDGE_DIR = "knowledge";
export const KNOWLEDGE_JSON = "entries.json";

// ─── Path Helpers ─────────────────────────────────────────────────────────────

export function getMemoryDir(rootDir: string): string {
  return path.join(rootDir, AI_MEMORY_DIR);
}

export function getIndexDir(rootDir: string): string {
  return path.join(rootDir, AI_MEMORY_DIR, INDEX_DIR);
}

export function getSummariesDir(rootDir: string): string {
  return path.join(rootDir, AI_MEMORY_DIR, SUMMARIES_DIR);
}

/**
 * Returns the local (per-developer) cache directory.
 * Lives in the user's home directory — never in the repo.
 */
export function getLocalCacheDir(projectId: string): string {
  return path.join(os.homedir(), ".vemora-cache", projectId);
}

/**
 * Derives a stable project ID from the root directory path.
 * This is deterministic so developers on the same machine always get the same ID,
 * but differs across machines (cache is local anyway).
 */
export function generateProjectId(rootDir: string): string {
  return crypto.createHash("sha256").update(rootDir).digest("hex").slice(0, 16);
}

// ─── Config Defaults ──────────────────────────────────────────────────────────

export function getDefaultConfig(
  rootDir: string,
  projectName: string,
): AiMemoryConfig {
  return {
    projectId: generateProjectId(rootDir),
    projectName,
    version: "1.0.0",
    rootDir,
    include: [
      "**/*.ts",
      "**/*.tsx",
      "**/*.js",
      "**/*.jsx",
      "**/*.py",
      "**/*.rs",
      "**/*.go",
      "**/*.java",
      "**/*.c",
      "**/*.cpp",
      "**/*.h",
      "**/*.css",
      "**/*.scss",
      "**/*.json",
      "**/*.yaml",
      "**/*.yml",
      "**/*.md",
    ],
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/build/**",
      "**/out/**",
      "**/.next/**",
      "**/.nuxt/**",
      "**/coverage/**",
      "**/*.min.js",
      "**/*.bundle.js",
      AI_MEMORY_DIR + "/**",
      AI_MEMORY_CACHE_DIR + "/**",
    ],
    maxChunkLines: 80,
    maxChunkChars: 3000,
    embedding: {
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: 768,
    },
    summarization: {
      provider: "ollama",
      model: "gemma4:e2b",
      baseUrl: "http://localhost:11434",
    },
    cacheDir: "~/.vemora-cache/<projectId>",
  };
}

// ─── Config I/O ───────────────────────────────────────────────────────────────

export function loadConfig(rootDir: string): AiMemoryConfig {
  const configPath = path.join(rootDir, AI_MEMORY_DIR, CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `No ${AI_MEMORY_DIR}/config.json found in ${rootDir}.\nRun 'vemora init' first.`,
    );
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  let config: AiMemoryConfig;
  try {
    config = JSON.parse(raw) as AiMemoryConfig;
  } catch {
    throw new Error(
      `${AI_MEMORY_DIR}/config.json is not valid JSON.\nFix the file manually or run 'vemora init --force' to reset it.`,
    );
  }
  // rootDir is injected at load time (not stored in config) so it always reflects
  // the actual filesystem location, even if the project was moved.
  config.rootDir = rootDir;
  return config;
}

export function saveConfig(config: AiMemoryConfig): void {
  const configPath = path.join(config.rootDir, AI_MEMORY_DIR, CONFIG_FILE);
  // Don't persist rootDir — it's injected at load time
  const { rootDir: _omit, ...toSave } = config;
  fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2), "utf-8");
}

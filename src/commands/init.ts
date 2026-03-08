import chalk from "chalk";
import fs from "fs";
import path from "path";
import {
  AI_MEMORY_CACHE_DIR,
  AI_MEMORY_DIR,
  CONFIG_FILE,
  getDefaultConfig,
  INDEX_DIR,
  loadConfig,
  METADATA_FILE,
  SUMMARIES_DIR,
  saveConfig,
} from "../core/config";
import type { Metadata } from "../core/types";

export async function runInit(rootDir: string): Promise<void> {
  console.log(chalk.bold("Initializing ai-memory..."));
  console.log(`Project root: ${chalk.cyan(rootDir)}`);
  console.log();

  const memoryDir = path.join(rootDir, AI_MEMORY_DIR);
  const indexDir = path.join(memoryDir, INDEX_DIR);
  const summariesDir = path.join(memoryDir, SUMMARIES_DIR);

  // ── 1. Create directory structure ─────────────────────────────────────────
  fs.mkdirSync(indexDir, { recursive: true });
  fs.mkdirSync(summariesDir, { recursive: true });
  console.log(
    chalk.green("✓") +
      ` Created ${chalk.gray(AI_MEMORY_DIR + "/index/")} and ${chalk.gray(AI_MEMORY_DIR + "/summaries/")}`,
  );

  // ── 2. config.json ────────────────────────────────────────────────────────
  const configPath = path.join(memoryDir, CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    const projectName = detectProjectName(rootDir);
    const config = getDefaultConfig(rootDir, projectName);
    saveConfig(config);
    console.log(
      chalk.green("✓") + ` Created ${chalk.gray(".ai-memory/config.json")}`,
    );
  } else {
    console.log(
      chalk.yellow("~") +
        ` ${chalk.gray(".ai-memory/config.json")} already exists, skipping`,
    );
  }

  // ── 3. metadata.json ──────────────────────────────────────────────────────
  const metaPath = path.join(memoryDir, METADATA_FILE);
  if (!fs.existsSync(metaPath)) {
    const config = loadConfig(rootDir);
    const meta: Metadata = {
      projectId: config.projectId,
      projectName: config.projectName,
      lastIndexed: null,
      indexedFiles: 0,
      totalChunks: 0,
      totalSymbols: 0,
      totalDepEdges: 0,
      embeddingProvider: config.embedding.provider,
      embeddingModel: config.embedding.model,
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    console.log(
      chalk.green("✓") + ` Created ${chalk.gray(".ai-memory/metadata.json")}`,
    );
  }

  // ── 4. Empty index files ──────────────────────────────────────────────────
  const indexFiles: Array<[string, string]> = [
    [path.join(indexDir, "files.json"), "{}"],
    [path.join(indexDir, "chunks.json"), "[]"],
    [path.join(indexDir, "symbols.json"), "{}"],
    [path.join(indexDir, "callgraph.json"), "{}"],
  ];
  for (const [filePath, emptyVal] of indexFiles) {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, emptyVal, "utf-8");
    }
  }
  console.log(
    chalk.green("✓") +
      ` Created ${chalk.gray(".ai-memory/index/{files,chunks,symbols,callgraph}.json")}`,
  );

  // ── 5. .gitignore ─────────────────────────────────────────────────────────
  await ensureGitignore(rootDir);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log();
  console.log(chalk.bold.green("Done!"));
  console.log();
  console.log("Next steps:");
  console.log(
    `  1. Review ${chalk.cyan(".ai-memory/config.json")} — adjust include/exclude patterns`,
  );
  console.log(
    `  2. Configure embedding provider (default: OpenAI via ${chalk.cyan("OPENAI_API_KEY")} env)`,
  );
  console.log(`  3. Run ${chalk.cyan("ai-memory index")} to build the index`);
  console.log(
    `  4. Run ${chalk.cyan('ai-memory query "your question"')} to search`,
  );
  console.log();
  console.log(
    chalk.gray(`Note: .ai-memory-cache/ is local-only and excluded from git.`),
  );
}

function detectProjectName(rootDir: string): string {
  try {
    const pkgPath = path.join(rootDir, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
        name?: string;
      };
      if (pkg.name) return pkg.name;
    }
    // Try pyproject.toml or Cargo.toml for non-JS projects
    const pyproject = path.join(rootDir, "pyproject.toml");
    if (fs.existsSync(pyproject)) {
      const content = fs.readFileSync(pyproject, "utf-8");
      const m = content.match(/^name\s*=\s*"([^"]+)"/m);
      if (m) return m[1];
    }
  } catch {
    // ignore
  }
  return path.basename(rootDir);
}

async function ensureGitignore(rootDir: string): Promise<void> {
  const gitignorePath = path.join(rootDir, ".gitignore");
  const entry = AI_MEMORY_CACHE_DIR + "/";

  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(
      gitignorePath,
      `# ai-memory local embedding cache\n${entry}\n`,
      "utf-8",
    );
    console.log(
      chalk.green("✓") +
        ` Created ${chalk.gray(".gitignore")} with ${chalk.gray(entry)}`,
    );
    return;
  }

  const existing = fs.readFileSync(gitignorePath, "utf-8");
  if (existing.includes(AI_MEMORY_CACHE_DIR)) {
    console.log(
      chalk.yellow("~") +
        ` ${chalk.gray(".gitignore")} already excludes ${chalk.gray(entry)}`,
    );
    return;
  }

  fs.appendFileSync(
    gitignorePath,
    `\n# ai-memory local embedding cache\n${entry}\n`,
    "utf-8",
  );
  console.log(
    chalk.green("✓") +
      ` Added ${chalk.gray(entry)} to ${chalk.gray(".gitignore")}`,
  );
}

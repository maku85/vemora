import fs from "fs";
import path from "path";
import type {
  DependencyGraph,
  FileDependencies,
  ImportEntry,
} from "../core/types";

// ─── tsconfig path alias resolution ──────────────────────────────────────────

export interface TsPathAlias {
  /** The literal prefix before the wildcard, e.g. "@/" for pattern "@/*" */
  prefix: string;
  /** Replacement targets, e.g. ["src/*"] */
  targets: string[];
  /** baseUrl from compilerOptions (relative to project root), e.g. "." */
  baseUrl: string;
}

/**
 * Reads tsconfig.json (or tsconfig.base.json / tsconfig.node.json) from
 * `rootDir` and extracts `compilerOptions.paths` as a list of alias entries.
 * Returns [] if no paths are found or the file cannot be parsed.
 */
export function loadTsPathAliases(rootDir: string): TsPathAlias[] {
  const candidates = [
    "tsconfig.json",
    "tsconfig.base.json",
    "tsconfig.node.json",
  ];

  for (const name of candidates) {
    const tsConfigPath = path.join(rootDir, name);
    try {
      const raw = fs.readFileSync(tsConfigPath, "utf-8");
      // tsconfig allows // comments — strip them before JSON.parse
      const stripped = raw
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      const config = JSON.parse(stripped);
      const opts = config.compilerOptions ?? {};
      const baseUrl: string = opts.baseUrl ?? ".";
      const paths: Record<string, string[]> = opts.paths ?? {};

      if (Object.keys(paths).length === 0) continue;

      return Object.entries(paths).map(([pattern, targets]) => ({
        prefix: pattern.replace(/\*$/, ""),
        targets,
        baseUrl,
      }));
    } catch {
      // file missing or invalid — try next candidate
    }
  }

  return [];
}

/**
 * Resolves a non-relative import source against the loaded tsconfig path
 * aliases. Returns a project-relative path if matched, otherwise null.
 */
function resolveAlias(
  source: string,
  aliases: TsPathAlias[],
  allFiles: Set<string>,
): string | null {
  for (const { prefix, targets, baseUrl } of aliases) {
    if (!source.startsWith(prefix)) continue;
    const rest = source.slice(prefix.length);

    for (const target of targets) {
      const resolved = target.replace("*", rest);
      const base = path.normalize(path.join(baseUrl, resolved));

      const extCandidates = ["", ".ts", ".tsx", ".js", ".jsx"];
      for (const ext of extCandidates) {
        const candidate = path.normalize(base + ext);
        if (allFiles.has(candidate)) return candidate;
      }
      for (const idx of ["index.ts", "index.tsx", "index.js"]) {
        const candidate = path.join(base, idx);
        if (allFiles.has(candidate)) return candidate;
      }
    }
  }
  return null;
}

// ─── Supported source extensions for import analysis ─────────────────────────

const JS_TS_EXTS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mts",
  "cts",
  "mjs",
  "cjs",
]);

// ─── Regex patterns ───────────────────────────────────────────────────────────

/**
 * Matches static import statements:
 *   import { A, B } from './path'
 *   import type { A } from './path'
 *   import A from './path'
 *   import * as A from './path'
 *   import './path'  (side-effect)
 */
const STATIC_IMPORT_RE =
  /^\s*import\s+(?:type\s+)?(?:(?:\{([^}]*)\}|(\w+)|\*\s+as\s+\w+)\s+from\s+)?['"]([^'"]+)['"]/gm;

/**
 * Matches re-export statements:
 *   export { A, B } from './path'
 *   export * from './path'
 *   export * as NS from './path'
 *   export type { A } from './path'
 */
const EXPORT_FROM_RE =
  /^\s*export\s+(?:type\s+)?(?:\{([^}]*)\}|\*(?:\s+as\s+\w+)?)\s+from\s+['"]([^'"]+)['"]/gm;

/**
 * Matches dynamic imports and require() calls:
 *   import('./path')
 *   require('./path')
 */
const DYNAMIC_RE = /(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

// ─── Import source extraction ─────────────────────────────────────────────────

interface RawImport {
  source: string;
  symbols: string[];
}

function extractRawImports(content: string): RawImport[] {
  const results: RawImport[] = [];

  // Static imports
  let m: RegExpExecArray | null;
  STATIC_IMPORT_RE.lastIndex = 0;
  while ((m = STATIC_IMPORT_RE.exec(content)) !== null) {
    const namedGroup = m[1]; // content inside { }
    const defaultName = m[2]; // default import identifier
    const source = m[3];
    if (!source) continue;

    const symbols: string[] = [];
    if (namedGroup) symbols.push(...parseNamedImports(namedGroup));
    if (defaultName && /^\w+$/.test(defaultName)) symbols.push(defaultName);

    results.push({ source, symbols });
  }

  // Re-exports
  EXPORT_FROM_RE.lastIndex = 0;
  while ((m = EXPORT_FROM_RE.exec(content)) !== null) {
    const namedGroup = m[1];
    const source = m[2];
    if (!source) continue;
    const symbols = namedGroup ? parseNamedImports(namedGroup) : [];
    results.push({ source, symbols });
  }

  // Dynamic imports / require
  DYNAMIC_RE.lastIndex = 0;
  while ((m = DYNAMIC_RE.exec(content)) !== null) {
    const source = m[1];
    if (source) results.push({ source, symbols: [] });
  }

  return results;
}

/**
 * Parses the content inside `{ A, B as C, type D }` → ['A', 'D']
 * Returns original (pre-alias) names only.
 */
function parseNamedImports(raw: string): string[] {
  return raw
    .split(",")
    .map((s) =>
      s
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        .trim(),
    )
    .filter((s) => s.length > 0 && /^\w+$/.test(s));
}

// ─── Path resolution ──────────────────────────────────────────────────────────

/** Returns true for relative imports (./foo, ../bar) — i.e. intra-project */
function isRelative(source: string): boolean {
  return source.startsWith("./") || source.startsWith("../");
}

/**
 * Resolves a relative import source to an actual file path that exists in
 * the project index. Handles:
 *   - Missing extensions (TypeScript allows `import './foo'` → `./foo.ts`)
 *   - Directory imports   (import './foo'    → './foo/index.ts')
 *   - .js ↔ .ts aliasing  (import './foo.js' → './foo.ts' in TS projects)
 */
function resolveImport(
  source: string,
  importerDir: string, // directory of the importing file (relative to root)
  allFiles: Set<string>,
): string | null {
  // Compute the base path relative to project root
  const base = path.normalize(path.join(importerDir, source));

  // Candidate extensions to try (in priority order)
  const extCandidates = ["", ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"];
  // If source already has an extension (e.g. .js in "import './foo.js'"),
  // also try swapping it to .ts (common in TypeScript projects)
  const sourceExt = path.extname(source);
  if (sourceExt === ".js") extCandidates.unshift(base.slice(0, -3) + ".ts");
  if (sourceExt === ".mjs") extCandidates.unshift(base.slice(0, -4) + ".mts");

  for (const ext of extCandidates) {
    const candidate =
      typeof ext === "string" && ext.startsWith("/")
        ? ext // already absolute-looking resolved path
        : base + ext;
    const norm = path.normalize(candidate);
    if (allFiles.has(norm)) return norm;
  }

  // Try as directory index
  const indexCandidates = ["index.ts", "index.tsx", "index.js", "index.jsx"];
  for (const idx of indexCandidates) {
    const candidate = path.join(base, idx);
    if (allFiles.has(candidate)) return candidate;
  }

  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extracts all intra-project imports from a single file's content.
 * Returns resolved ImportEntry[] (only files that exist in the index).
 *
 * @param relativePath  - path of this file relative to project root
 * @param content       - file content
 * @param allFiles      - set of all relative paths in the project index
 */
export function extractFileImports(
  relativePath: string,
  content: string,
  allFiles: Set<string>,
  aliases: TsPathAlias[] = [],
): ImportEntry[] {
  const ext = path.extname(relativePath).slice(1).toLowerCase();
  if (!JS_TS_EXTS.has(ext)) return []; // only JS/TS files have parseable imports

  const importerDir = path.dirname(relativePath);
  const raw = extractRawImports(content);

  // Deduplicate by resolved file path, merging symbols
  const resolved = new Map<string, Set<string>>();

  for (const { source, symbols } of raw) {
    let resolvedPath: string | null = null;
    if (isRelative(source)) {
      resolvedPath = resolveImport(source, importerDir, allFiles);
    } else if (aliases.length > 0) {
      resolvedPath = resolveAlias(source, aliases, allFiles);
    }
    if (!resolvedPath || resolvedPath === relativePath) continue; // skip self-imports

    const existing = resolved.get(resolvedPath) ?? new Set<string>();
    for (const s of symbols) existing.add(s);
    resolved.set(resolvedPath, existing);
  }

  return Array.from(resolved.entries()).map(([file, syms]) => ({
    file,
    symbols: Array.from(syms).sort(),
  }));
}

/**
 * Incrementally updates the dependency graph.
 *
 * - Changed/new files: re-extract imports from content
 * - Unchanged files:   carry forward existing deps entries
 * - Deleted files:     remove from graph
 */
export function updateDependencyGraph(
  prevGraph: DependencyGraph,
  changedFiles: Map<string, string>, // relativePath → content (new/changed files)
  deletedFiles: Set<string>,
  allFiles: Set<string>,
  aliases: TsPathAlias[] = [],
): DependencyGraph {
  const graph: DependencyGraph = {};

  // Carry forward unchanged entries
  for (const [file, deps] of Object.entries(prevGraph)) {
    if (!deletedFiles.has(file) && !changedFiles.has(file)) {
      graph[file] = deps;
    }
  }

  // Re-process changed/new files
  for (const [relativePath, content] of changedFiles) {
    const imports = extractFileImports(relativePath, content, allFiles, aliases);
    if (imports.length > 0) {
      graph[relativePath] = { imports };
    }
  }

  return graph;
}

/**
 * Computes the reverse graph: for each file, which files import it.
 * Derived at query time — not stored in the index.
 */
export function computeImportedBy(
  graph: DependencyGraph,
): Map<string, string[]> {
  const importedBy = new Map<string, string[]>();

  for (const [file, { imports }] of Object.entries(graph)) {
    for (const imp of imports) {
      const list = importedBy.get(imp.file) ?? [];
      list.push(file);
      importedBy.set(imp.file, list);
    }
  }

  return importedBy;
}

/**
 * Returns all files that (transitively) import `startFile`, up to `depth` hops
 * in the reverse dependency graph (following importedBy edges inward).
 */
export function getTransitiveImportedBy(
  startFile: string,
  importedByMap: Map<string, string[]>,
  depth = 1,
): Map<string, number> {
  const visited = new Map<string, number>(); // file → distance
  const queue: Array<[string, number]> = [[startFile, 0]];
  let head = 0;

  while (head < queue.length) {
    const [file, dist] = queue[head++];
    if (dist >= depth) continue;

    for (const importer of importedByMap.get(file) ?? []) {
      if (!visited.has(importer)) {
        visited.set(importer, dist + 1);
        queue.push([importer, dist + 1]);
      }
    }
  }

  return visited;
}

/**
 * Returns all files reachable from `startFile` up to `depth` hops
 * in the dependency graph (following imports outward).
 */
export function getTransitiveDeps(
  startFile: string,
  graph: DependencyGraph,
  depth = 1,
): Map<string, number> {
  const visited = new Map<string, number>(); // file → distance
  const queue: Array<[string, number]> = [[startFile, 0]];
  let head = 0;

  while (head < queue.length) {
    const [file, dist] = queue[head++];
    if (dist > depth) break;

    for (const imp of graph[file]?.imports ?? []) {
      if (!visited.has(imp.file)) {
        visited.set(imp.file, dist + 1);
        queue.push([imp.file, dist + 1]);
      }
    }
  }

  return visited;
}

/**
 * Detects circular dependencies using DFS with a recursion stack (gray-set).
 * Returns up to 5 unique cycles, each as an ordered list of file paths
 * (first element === last element to make the loop explicit).
 */
export function detectCycles(graph: DependencyGraph): string[][] {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  const cycles: string[][] = [];

  function dfs(node: string, stack: string[]): void {
    color.set(node, GRAY);
    stack.push(node);

    for (const imp of graph[node]?.imports ?? []) {
      const c = color.get(imp.file) ?? WHITE;
      if (c === GRAY) {
        const idx = stack.indexOf(imp.file);
        if (idx !== -1) cycles.push([...stack.slice(idx), imp.file]);
      } else if (c === WHITE) {
        dfs(imp.file, stack);
      }
      if (cycles.length >= 5) break; // cap early
    }

    stack.pop();
    color.set(node, BLACK);
  }

  for (const file of Object.keys(graph)) {
    if ((color.get(file) ?? WHITE) === WHITE) dfs(file, []);
    if (cycles.length >= 5) break;
  }

  // Deduplicate: same cycle can be discovered starting from different nodes
  const seen = new Set<string>();
  return cycles.filter((cycle) => {
    const key = [...cycle].sort().join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Stats about the dependency graph for display in `vemora status`.
 */
export function graphStats(graph: DependencyGraph): {
  totalFiles: number;
  totalEdges: number;
  mostImported: Array<{ file: string; count: number }>;
} {
  const importedByCount = new Map<string, number>();
  let totalEdges = 0;

  for (const { imports } of Object.values(graph)) {
    totalEdges += imports.length;
    for (const imp of imports) {
      importedByCount.set(imp.file, (importedByCount.get(imp.file) ?? 0) + 1);
    }
  }

  const mostImported = Array.from(importedByCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([file, count]) => ({ file, count }));

  return { totalFiles: Object.keys(graph).length, totalEdges, mostImported };
}

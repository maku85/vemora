import path from "path";

// Common test file suffixes and directory patterns
const TEST_SUFFIXES = [".test.ts", ".test.tsx", ".test.js", ".test.jsx",
                       ".spec.ts", ".spec.tsx", ".spec.js", ".spec.jsx"];
const TEST_DIRS = ["__tests__", "test", "tests", "spec", "__spec__"];

/**
 * Returns all test files in the project that are likely to test `relPath`.
 *
 * Two strategies (both applied, results deduplicated):
 *  1. Convention-based: look for sibling files with `.test.*` / `.spec.*`
 *     suffix, and for the same basename inside common test directories.
 *  2. Import-based: any file whose path contains "test" or "spec" that is
 *     known to import `relPath` (via the dependency graph).
 *
 * @param relPath       The source file to find tests for (project-relative)
 * @param allFiles      All known project-relative file paths
 * @param importedBy    Optional map of file → set of files that import it
 */
export function findTestFiles(
  relPath: string,
  allFiles: Iterable<string>,
  importedBy?: Map<string, string[]>,
): string[] {
  const allFilesSet = new Set(allFiles);
  const found = new Set<string>();

  const dir = path.dirname(relPath);
  const base = path.basename(relPath);
  // Strip known source extension to get the bare stem (e.g. "foo")
  const stem = base.replace(/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/, "");

  // Strategy 1a: sibling test files in the same directory
  for (const suffix of TEST_SUFFIXES) {
    const candidate = path.join(dir, stem + suffix);
    if (allFilesSet.has(candidate)) found.add(candidate);
  }

  // Strategy 1b: same stem inside adjacent test directories
  for (const testDir of TEST_DIRS) {
    for (const suffix of TEST_SUFFIXES) {
      // e.g. src/__tests__/foo.test.ts
      const inSiblingDir = path.join(dir, testDir, stem + suffix);
      if (allFilesSet.has(inSiblingDir)) found.add(inSiblingDir);

      // e.g. __tests__/foo.test.ts (root-level test dir)
      const inRootDir = path.join(testDir, stem + suffix);
      if (allFilesSet.has(inRootDir)) found.add(inRootDir);
    }
    // Bare filename without suffix (e.g. __tests__/foo.ts)
    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
      const inSiblingDir = path.join(dir, testDir, stem + ext);
      if (allFilesSet.has(inSiblingDir)) found.add(inSiblingDir);
    }
  }

  // Strategy 2: import-based — files that import relPath and look like tests
  if (importedBy) {
    const importers = importedBy.get(relPath) ?? [];
    for (const importer of importers) {
      if (/[./](test|spec)[./]|\.test\.|\.spec\./.test(importer)) {
        found.add(importer);
      }
    }
  }

  return Array.from(found).sort();
}

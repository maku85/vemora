import { spawnSync } from "child_process";

export interface GitCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

/**
 * Returns the N most recent git commits that touched a file.
 * Returns [] if git is unavailable, the file has no history, or rootDir is not
 * inside a git repository.
 *
 * Uses --follow so renames/moves are tracked across history.
 */
export function getFileGitHistory(
  rootDir: string,
  relPath: string,
  maxCommits = 5,
): GitCommit[] {
  const SEP = "\x1f";
  const result = spawnSync(
    "git",
    [
      "log",
      `--max-count=${maxCommits}`,
      `--format=%H${SEP}%s${SEP}%an${SEP}%ai`,
      "--follow",
      "--",
      relPath,
    ],
    { cwd: rootDir, encoding: "utf-8" },
  );

  if (result.status !== 0 || !result.stdout?.trim()) return [];

  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, message, author, date] = line.split(SEP);
      return {
        sha: (sha ?? "").slice(0, 8),
        message: (message ?? "").trim(),
        author: (author ?? "").trim(),
        date: (date ?? "").slice(0, 10),
      };
    });
}

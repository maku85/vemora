import fs from "fs";
import path from "path";
import {
  AI_MEMORY_DIR,
  FILE_SUMMARIES_JSON,
  PROJECT_SUMMARY_JSON,
  SUMMARIES_DIR,
} from "../core/config";
import type { FileSummaryIndex, ProjectSummary } from "../core/types";

/**
 * Reads and writes LLM-generated summary files stored in .ai-memory/summaries/.
 * These files are committed to git so the whole team shares the same summaries.
 */
export class SummaryStorage {
  private summariesDir: string;

  constructor(rootDir: string) {
    this.summariesDir = path.join(rootDir, AI_MEMORY_DIR, SUMMARIES_DIR);
  }

  // ─── File Summaries ──────────────────────────────────────────────────────────

  loadFileSummaries(): FileSummaryIndex {
    return this.readJson<FileSummaryIndex>(
      path.join(this.summariesDir, FILE_SUMMARIES_JSON),
      {},
    );
  }

  saveFileSummaries(index: FileSummaryIndex): void {
    this.writeJson(path.join(this.summariesDir, FILE_SUMMARIES_JSON), index);
  }

  // ─── Project Summary ─────────────────────────────────────────────────────────

  loadProjectSummary(): ProjectSummary | null {
    const p = path.join(this.summariesDir, PROJECT_SUMMARY_JSON);
    if (!fs.existsSync(p)) return null;
    return this.readJson<ProjectSummary>(p, null as unknown as ProjectSummary);
  }

  saveProjectSummary(summary: ProjectSummary): void {
    this.writeJson(path.join(this.summariesDir, PROJECT_SUMMARY_JSON), summary);
  }

  // ─── Status helpers ───────────────────────────────────────────────────────────

  hasFileSummaries(): boolean {
    return fs.existsSync(path.join(this.summariesDir, FILE_SUMMARIES_JSON));
  }

  hasProjectSummary(): boolean {
    return fs.existsSync(path.join(this.summariesDir, PROJECT_SUMMARY_JSON));
  }

  getSummariesDir(): string {
    return this.summariesDir;
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

import fs from "fs";
import path from "path";
import { getLocalCacheDir } from "../core/config";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlanSession {
  sessionId: string;
  /** Short 8-char prefix for display */
  shortId: string;
  task: string;
  rootDir: string;
  createdAt: string;
  updatedAt: string;
  status: "running" | "completed" | "failed";
  plan: {
    goal: string;
    steps: unknown[];
  };
  /** stepId (string key) → executor answer */
  stepResults: Record<string, string>;
  /** IDs of all steps that completed successfully */
  completedStepIds: number[];
  /** Next available step ID for adaptive re-planning */
  nextId: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSIONS_SUBDIR = "sessions";

// ─── Storage ──────────────────────────────────────────────────────────────────

/**
 * Persists plan execution state to the local developer cache.
 * Stored in ~/.vemora-cache/<projectId>/sessions/<sessionId>.json
 * Never committed to git — local to the developer.
 */
export class PlanSessionStorage {
  private sessionsDir: string;

  constructor(projectId: string) {
    this.sessionsDir = path.join(
      getLocalCacheDir(projectId),
      SESSIONS_SUBDIR,
    );
  }

  save(session: PlanSession): void {
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
    const filePath = path.join(this.sessionsDir, `${session.sessionId}.json`);
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(session, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
  }

  /**
   * Load a session by full UUID or by 8-char prefix.
   * Returns null if not found.
   */
  load(sessionIdOrPrefix: string): PlanSession | null {
    if (!fs.existsSync(this.sessionsDir)) return null;
    const files = fs.readdirSync(this.sessionsDir).filter((f) =>
      f.endsWith(".json"),
    );
    const match = files.find(
      (f) =>
        f === `${sessionIdOrPrefix}.json` ||
        f.startsWith(sessionIdOrPrefix),
    );
    if (!match) return null;
    try {
      return JSON.parse(
        fs.readFileSync(path.join(this.sessionsDir, match), "utf-8"),
      ) as PlanSession;
    } catch {
      return null;
    }
  }

  /** List all sessions, newest first. */
  list(): PlanSession[] {
    if (!fs.existsSync(this.sessionsDir)) return [];
    return fs
      .readdirSync(this.sessionsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(
            fs.readFileSync(path.join(this.sessionsDir, f), "utf-8"),
          ) as PlanSession;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort(
        (a, b) =>
          new Date(b!.updatedAt).getTime() - new Date(a!.updatedAt).getTime(),
      ) as PlanSession[];
  }

  delete(sessionId: string): boolean {
    const filePath = path.join(this.sessionsDir, `${sessionId}.json`);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }
}

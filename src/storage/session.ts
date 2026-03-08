import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getLocalCacheDir } from "../core/config";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionState {
  sessionId: string;
  /** ISO timestamp of last query in this session */
  lastActiveAt: string;
  /** Chunk IDs already returned to the LLM in this session */
  seenChunkIds: string[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Idle duration after which a session is considered expired (30 min) */
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_FILE = "session.json";

// ─── Storage ──────────────────────────────────────────────────────────────────

/**
 * Manages per-project session memory stored in the local developer cache.
 *
 * The session tracks which chunk IDs have been returned to the LLM so that
 * subsequent queries can skip already-seen chunks. Sessions auto-expire after
 * 30 minutes of idle time.
 *
 * Stored in ~/.ai-memory-cache/<projectId>/session.json — never in the repo.
 */
export class SessionStorage {
  private filePath: string;

  constructor(projectId: string) {
    const dir = getLocalCacheDir(projectId);
    this.filePath = path.join(dir, SESSION_FILE);
  }

  private load(): SessionState | null {
    if (!fs.existsSync(this.filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as SessionState;
    } catch {
      return null;
    }
  }

  /**
   * Returns the active session, or creates a new one if expired or absent.
   * A session expires after SESSION_TIMEOUT_MS of inactivity.
   */
  loadOrCreate(): SessionState {
    const existing = this.load();
    if (existing) {
      const idle = Date.now() - new Date(existing.lastActiveAt).getTime();
      if (idle < SESSION_TIMEOUT_MS) return existing;
    }
    return this.newSession();
  }

  private newSession(): SessionState {
    return {
      sessionId: crypto.randomBytes(8).toString("hex"),
      lastActiveAt: new Date().toISOString(),
      seenChunkIds: [],
    };
  }

  private saveState(state: SessionState): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), "utf-8");
  }

  /** Resets the session to a clean state (new session ID, empty seen list). */
  reset(): SessionState {
    const fresh = this.newSession();
    this.saveState(fresh);
    return fresh;
  }

  /**
   * Adds chunk IDs to the seen set and refreshes the session timestamp.
   * Creates or continues the current session as needed.
   */
  markSeen(chunkIds: string[]): void {
    const state = this.loadOrCreate();
    const seen = new Set(state.seenChunkIds);
    for (const id of chunkIds) seen.add(id);
    state.seenChunkIds = Array.from(seen);
    state.lastActiveAt = new Date().toISOString();
    this.saveState(state);
  }

  /** Returns the set of chunk IDs seen in the current (unexpired) session. */
  getSeenIds(): Set<string> {
    const state = this.load();
    if (!state) return new Set();
    const idle = Date.now() - new Date(state.lastActiveAt).getTime();
    if (idle >= SESSION_TIMEOUT_MS) return new Set();
    return new Set(state.seenChunkIds);
  }
}

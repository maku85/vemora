import fs from "fs";
import path from "path";
import { getLocalCacheDir } from "../core/config";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UsageEvent {
  /** ISO timestamp of the query */
  ts: string;
  command: "query" | "context" | "ask";
  /** Query text, truncated to 120 chars */
  query?: string;
  searchType: "vector" | "bm25" | "hybrid" | "symbol" | "none";
  format?: string;
  /** Top-K requested */
  topK: number;
  /** Chunks actually returned to the caller */
  resultsReturned: number;
  /** Estimated tokens in returned chunks */
  tokensReturned: number;
  /** Tokens saved by semantic deduplication (0 if dedup didn't fire) */
  tokensSavedDedup: number;
  /** Tokens saved by session filter (0 if --session not active) */
  tokensSavedSession: number;
  /** Tokens saved by budget cap (0 if --budget not set) */
  tokensSavedBudget: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const USAGE_FILE = "usage.log.json";
/** Maximum events to retain (rolling buffer) */
const MAX_EVENTS = 2000;

// ─── Storage ──────────────────────────────────────────────────────────────────

/**
 * Append-only log of usage events stored in the local developer cache.
 * Never committed to git — per-developer analytics only.
 *
 * Stored in ~/.vemora-cache/<projectId>/usage.log.json
 */
export class UsageStorage {
  private filePath: string;

  constructor(projectId: string) {
    const dir = getLocalCacheDir(projectId);
    this.filePath = path.join(dir, USAGE_FILE);
  }

  load(): UsageEvent[] {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as UsageEvent[];
    } catch {
      return [];
    }
  }

  append(event: UsageEvent): void {
    const events = this.load();
    events.push(event);
    // Keep only the most recent MAX_EVENTS
    const pruned = events.length > MAX_EVENTS ? events.slice(-MAX_EVENTS) : events;

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(pruned, null, 2), "utf-8");
  }

  clear(): void {
    if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
  }
}

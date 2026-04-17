import fs from "fs";
import path from "path";
import { AI_MEMORY_DIR, KNOWLEDGE_DIR, KNOWLEDGE_JSON } from "../core/config";
import type { KnowledgeEntry } from "../core/types";

/**
 * Reads and writes the knowledge store at .vemora/knowledge/entries.json.
 * Committed to git so the whole team shares the same knowledge base.
 */
export class KnowledgeStorage {
  private knowledgeDir: string;
  private entriesPath: string;

  constructor(rootDir: string) {
    this.knowledgeDir = path.join(rootDir, AI_MEMORY_DIR, KNOWLEDGE_DIR);
    this.entriesPath = path.join(this.knowledgeDir, KNOWLEDGE_JSON);
  }

  load(): KnowledgeEntry[] {
    if (!fs.existsSync(this.entriesPath)) return [];
    try {
      return JSON.parse(
        fs.readFileSync(this.entriesPath, "utf-8"),
      ) as KnowledgeEntry[];
    } catch {
      return [];
    }
  }

  save(entries: KnowledgeEntry[]): void {
    fs.mkdirSync(this.knowledgeDir, { recursive: true });
    const tmp = this.entriesPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(entries), "utf-8");
    fs.renameSync(tmp, this.entriesPath);
  }

  add(entry: KnowledgeEntry): void {
    const entries = this.load();
    entries.push(entry);
    this.save(entries);
  }

  remove(id: string): boolean {
    const entries = this.load();
    const next = entries.filter((e) => e.id !== id);
    if (next.length === entries.length) return false;
    this.save(next);
    return true;
  }

  update(id: string, patch: Partial<Omit<KnowledgeEntry, "id" | "createdAt" | "createdBy">>): boolean {
    const entries = this.load();
    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    entries[idx] = { ...entries[idx], ...patch };
    this.save(entries);
    return true;
  }

  invalidate(id: string): boolean {
    const entries = this.load();
    const match = entries.find((e) => e.id === id);
    if (!match) return false;
    match.validUntil = new Date().toISOString();
    this.save(entries);
    return true;
  }

  hasKnowledge(): boolean {
    return fs.existsSync(this.entriesPath);
  }

  getKnowledgeDir(): string {
    return this.knowledgeDir;
  }
}

/**
 * Returns only entries that are valid at the given point in time.
 * Entries without validFrom/validUntil are treated as always-valid.
 */
export function filterValidAt(
  entries: KnowledgeEntry[],
  asOf: Date = new Date(),
): KnowledgeEntry[] {
  return entries.filter((e) => {
    if (e.validFrom && new Date(e.validFrom) > asOf) return false;
    if (e.validUntil && new Date(e.validUntil) <= asOf) return false;
    return true;
  });
}

import fs from "fs";
import path from "path";
import { AI_MEMORY_DIR, KNOWLEDGE_DIR, KNOWLEDGE_JSON } from "../core/config";
import type { KnowledgeEntry } from "../core/types";

/**
 * Reads and writes the knowledge store at .ai-memory/knowledge/entries.json.
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
    fs.writeFileSync(
      this.entriesPath,
      JSON.stringify(entries, null, 2),
      "utf-8",
    );
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

  hasKnowledge(): boolean {
    return fs.existsSync(this.entriesPath);
  }

  getKnowledgeDir(): string {
    return this.knowledgeDir;
  }
}

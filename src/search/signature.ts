/**
 * Signature extraction for code chunks.
 *
 * Given the raw content of a chunk, returns the declaration signature —
 * the part that describes *what* exists without the implementation body.
 * This is used in the query output for medium-relevance results.
 *
 * Design philosophy:
 *   - Interfaces and type aliases ARE their signature → show them in full (compact)
 *   - Functions and classes → extract up to the opening brace, replace body with { … }
 *   - Arrow functions with expression bodies → show up to =>
 *   - Everything else → show first meaningful lines
 */

const MAX_SIG_LINES = 10;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extracts the declaration signature from a chunk's content.
 *
 * Examples:
 *
 *   Input:  "export async function connect(\n  host: string,\n): Promise<void> {\n  ..."
 *   Output: "export async function connect(\n  host: string,\n): Promise<void> { … }"
 *
 *   Input:  "export interface ImapConfig {\n  host: string;\n}"
 *   Output: (same — interfaces are returned as-is, they are compact)
 *
 *   Input:  "export const send = async (msg: Email): Promise<void> =>\n  smtp.send(msg);"
 *   Output: "export const send = async (msg: Email): Promise<void> => …"
 */
export function extractSignature(content: string): string {
  const lines = content.split("\n");
  const firstMeaningful = lines.find((l) => l.trim().length > 0) ?? "";

  // ── Interfaces and type aliases ──────────────────────────────────────────
  // These are inherently compact — the full declaration IS the signature.
  // Show up to 20 lines (rare for them to be longer).
  if (/^\s*(export\s+)?(type\s+\w|interface\s+\w)/.test(firstMeaningful)) {
    const slice = lines.slice(0, 20);
    if (lines.length > 20) slice.push("  …");
    return slice.join("\n").trim();
  }

  // ── File header / import blocks ──────────────────────────────────────────
  // Chunks that are just import statements — show first 5 lines.
  if (/^\s*import\s/.test(firstMeaningful)) {
    const slice = lines.slice(0, 5);
    if (lines.length > 5) slice.push(`  … (${lines.length - 5} more lines)`);
    return slice.join("\n").trim();
  }

  // ── Function / class / method declarations ───────────────────────────────
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimEnd();

    // Line ends with opening brace → body starts here.
    // Captures patterns like:
    //   ): Promise<void> {
    //   export class Foo extends Bar {
    //   } catch (e) {          (skip mid-function braces — result.length guard)
    if (/\{\s*(\/\/[^\n]*)?\s*$/.test(trimmed)) {
      // Strip the brace (and any trailing comment) and append { … }
      const withoutBrace = trimmed
        .replace(/\s*\{\s*(\/\/[^\n]*)?\s*$/, "")
        .trimEnd();
      result.push(
        (withoutBrace !== ""
          ? withoutBrace
          : trimmed.replace(/\{.*$/, "").trim()) + " { … }",
      );
      break;
    }

    // Arrow function with expression body:
    //   const f = (x: number) =>
    //     x * 2
    if (trimmed.endsWith("=>") && !trimmed.endsWith("=>>")) {
      result.push(trimmed + " …");
      break;
    }

    result.push(line);

    // Single-line declarations ending with `;` (e.g. `declare function f(): void;`)
    if (result.length === 1 && trimmed.endsWith(";")) break;

    // Safety cap
    if (result.length >= MAX_SIG_LINES) {
      result.push("  …");
      break;
    }
  }

  return result.join("\n").trim();
}

// ─── Display tier ─────────────────────────────────────────────────────────────

export type DisplayTier = "high" | "med" | "low";

/**
 * Determines how much of a chunk to show based on its rank in results.
 *
 *   high (rank 1-3)  → full code block (capped at MAX_HIGH_LINES automatically)
 *   med  (rank 4-7)  → signature only (declaration without body)
 *   low  (rank 8+)   → file + symbol + score only (no code)
 *
 * The --show-code flag overrides all tiers to show full code.
 */
export function getDisplayTier(rank: number): DisplayTier {
  if (rank <= 3) return "high";
  if (rank <= 7) return "med";
  return "low";
}

/** Lines shown automatically for high-tier results (without --show-code) */
export const HIGH_CODE_LINES = 30;

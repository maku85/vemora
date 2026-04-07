import chalk from "chalk";
import { loadConfig } from "../core/config";
import type { Chunk } from "../core/types";
import { RepositoryStorage } from "../storage/repository";

// ─── Public types ─────────────────────────────────────────────────────────────

export type TriageType = "bugs" | "security" | "performance";

export interface TriageOptions {
  /** Audit types to run (default: all three) */
  types?: TriageType[];
  /** Max findings to return, sorted by score (default: 30) */
  topK?: number;
  /** Skip findings with score below this threshold (default: 1) */
  minScore?: number;
  /** Output format */
  output?: "terminal" | "json" | "markdown";
  /** Restrict analysis to files matching this substring */
  file?: string;
}

export interface TriageMatch {
  heuristic: string;
  category: string;
  severity: "high" | "medium" | "low";
  reason: string;
  /** Absolute 1-based line number within the file */
  line: number;
  /** Trimmed line content (up to 120 chars) */
  snippet: string;
}

export interface TriageFinding {
  file: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  score: number;
  matches: TriageMatch[];
}

// ─── Heuristics ───────────────────────────────────────────────────────────────

type Severity = "high" | "medium" | "low";

const SEVERITY_SCORE: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

interface Heuristic {
  name: string;
  /** Applied per-line first; if no line matches, applied to full chunk content */
  pattern: RegExp;
  /**
   * If this pattern matches anywhere in the chunk content, the finding is
   * suppressed. Used to eliminate false positives where the risky call is
   * already guarded (e.g. JSON.parse inside a try block).
   */
  guardPattern?: RegExp;
  /**
   * When true, the multi-line fallback runs on the RAW chunk content instead
   * of the comment-stripped version. Use for patterns like empty-catch where
   * a catch body made of only comments is still a real finding.
   * All other heuristics default to strippedContent to avoid JSDoc false positives.
   */
  multiline?: boolean;
  /**
   * If this pattern does NOT match the (stripped) chunk content, the finding
   * is suppressed. Complementary to guardPattern: use to require a specific
   * context (e.g. a loop) for the heuristic to fire.
   */
  requirePattern?: RegExp;
  category: string;
  severity: Severity;
  reason: string;
  types: TriageType[];
}

const HEURISTICS: Heuristic[] = [
  // ── BUGS ─────────────────────────────────────────────────────────────────────
  {
    name: "empty-catch",
    pattern: /catch\s*\([^)]*\)\s*\{\s*\}/,
    multiline: true,
    category: "Error Handling",
    severity: "high",
    reason: "Empty catch silently swallows errors — add logging or rethrow",
    types: ["bugs"],
  },
  {
    name: "async-foreach",
    pattern: /\.forEach\s*\(\s*async\b/,
    category: "Async",
    severity: "high",
    reason: "async callback in forEach is not awaited — errors and results are lost",
    types: ["bugs", "performance"],
  },
  {
    name: "json-parse-unguarded",
    pattern: /\bJSON\.parse\s*\(/,
    guardPattern: /\btry\s*\{/,
    category: "Error Handling",
    severity: "medium",
    reason: "JSON.parse throws on malformed input — wrap in try/catch",
    types: ["bugs"],
  },
  {
    name: "non-null-assertion",
    pattern: /[a-zA-Z_$][\w$]*!\.[a-zA-Z_$]/,
    category: "Null Safety",
    severity: "medium",
    reason: "Non-null assertion (!) bypasses type safety and may throw at runtime",
    types: ["bugs"],
  },
  {
    name: "explicit-any",
    pattern: /(?::\s*any\b|as\s+any\b)/,
    category: "Type Safety",
    severity: "low",
    reason: "Explicit any disables type checking — potential source of hidden bugs",
    types: ["bugs"],
  },
  {
    name: "process-exit",
    pattern: /\bprocess\.exit\s*\(/,
    category: "Control Flow",
    severity: "medium",
    reason: "process.exit() terminates immediately — avoid in library/shared code",
    types: ["bugs"],
  },
  {
    name: "float-equality",
    pattern: /(?:===|!==)\s*\d+\.\d+|\d+\.\d+\s*(?:===|!==)/,
    category: "Float Precision",
    severity: "low",
    reason: "Strict equality on floating-point values may fail due to IEEE 754 rounding",
    types: ["bugs"],
  },
  {
    name: "promise-no-catch",
    pattern: /\bPromise\.all\s*\(|Promise\.allSettled\s*\(|Promise\.race\s*\(/,
    category: "Async",
    severity: "low",
    reason: "Promise combinator — verify rejection handling is in place",
    types: ["bugs"],
  },

  // ── SECURITY ──────────────────────────────────────────────────────────────────
  {
    name: "hardcoded-secret",
    pattern: /(?:password|passwd|secret|api[_-]?key|token|private[_-]?key)\s*[=:]\s*['"][^'"]{4,}['"]/i,
    category: "Hardcoded Credential",
    severity: "high",
    reason: "Credential hardcoded in source — rotate and move to environment variable",
    types: ["security"],
  },
  {
    name: "eval",
    pattern: /\beval\s*\(/,
    category: "Code Injection",
    severity: "high",
    reason: "eval() executes arbitrary strings — remote code execution risk",
    types: ["security"],
  },
  {
    name: "new-function",
    pattern: /\bnew\s+Function\s*\(/,
    category: "Code Injection",
    severity: "high",
    reason: "new Function() executes arbitrary code — equivalent risk to eval()",
    types: ["security"],
  },
  {
    name: "weak-hash",
    pattern: /createHash\s*\(\s*['"](?:md5|sha1)['"]\s*\)/,
    category: "Weak Cryptography",
    severity: "high",
    reason: "MD5/SHA1 are cryptographically broken — use SHA-256 or stronger",
    types: ["security"],
  },
  {
    name: "inner-html",
    pattern: /\.(innerHTML|outerHTML)\s*=/,
    category: "XSS",
    severity: "high",
    reason: "Assigning to innerHTML/outerHTML with untrusted input causes XSS",
    types: ["security"],
  },
  {
    name: "sensitive-log",
    pattern: /console\.\w+\s*\([^)]*(?:password|token|secret|apikey|api_key)/i,
    category: "Information Disclosure",
    severity: "high",
    reason: "Sensitive value written to logs — may be captured by aggregators",
    types: ["security"],
  },
  {
    name: "shell-exec",
    pattern: /\bexec(?:Sync)?\s*\(|child_process\b/,
    category: "Command Injection",
    severity: "medium",
    reason: "Shell execution — verify that input is not user-controlled",
    types: ["security"],
  },
  {
    name: "http-url",
    pattern: /['"]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/,
    category: "Transport Security",
    severity: "medium",
    reason: "Plaintext HTTP to external host — use HTTPS",
    types: ["security"],
  },
  {
    name: "math-random-security",
    pattern: /Math\.random\s*\(\s*\)/,
    category: "Weak Randomness",
    severity: "low",
    reason: "Math.random() is not cryptographically secure — use crypto.randomBytes() for security-sensitive contexts",
    types: ["security"],
  },

  // ── PERFORMANCE ───────────────────────────────────────────────────────────────
  {
    // High: sync I/O inside a loop — genuinely blocks the event loop on every iteration.
    // requirePattern ensures this only fires when a loop construct is present in the chunk.
    // guardPattern on `sync-io` (below) deduplicates: that heuristic won't fire on the
    // same chunks where a loop is present.
    name: "sync-io-in-loop",
    pattern: /\b(?:readFileSync|writeFileSync|appendFileSync|statSync|readdirSync|rmSync|unlinkSync|copyFileSync|renameSync)\s*\(/,
    requirePattern: /\b(?:for\s*\(|while\s*\(|\.forEach\s*\(|\.map\s*\(|\.flatMap\s*\(|\.reduce\s*\(|\.filter\s*\(|\.find\s*\()\b/,
    category: "Synchronous I/O in Loop",
    severity: "high",
    reason: "Synchronous filesystem call inside a loop — blocks the event loop on every iteration",
    types: ["performance"],
  },
  {
    // Low: sync I/O outside a loop — often acceptable in CLI/setup code.
    // guardPattern suppresses this when a loop is present (sync-io-in-loop covers that case).
    name: "sync-io",
    pattern: /\b(?:readFileSync|writeFileSync|appendFileSync|existsSync|statSync|readdirSync|mkdirSync|rmSync|unlinkSync|copyFileSync|renameSync)\s*\(/,
    guardPattern: /\b(?:for\s*\(|while\s*\(|\.forEach\s*\(|\.map\s*\(|\.flatMap\s*\(|\.reduce\s*\(|\.filter\s*\(|\.find\s*\()\b/,
    category: "Synchronous I/O",
    severity: "low",
    reason: "Synchronous filesystem call — acceptable in CLI/setup code, avoid in server hot paths or loops",
    types: ["performance"],
  },
  {
    name: "json-roundtrip",
    pattern: /JSON\.parse\s*\(\s*JSON\.stringify\s*\(/,
    category: "Unnecessary Serialization",
    severity: "medium",
    reason: "JSON roundtrip for deep clone is slow — use structuredClone() instead",
    types: ["performance"],
  },
  {
    name: "filter-map-chain",
    pattern: /\.filter\s*\([^)]+\)\s*\.map\s*\(/,
    category: "Redundant Iteration",
    severity: "low",
    reason: ".filter().map() iterates twice — consider .flatMap() or a single .reduce()",
    types: ["performance"],
  },
  {
    name: "runtime-regex",
    pattern: /\bnew\s+RegExp\s*\(/,
    category: "Redundant Computation",
    severity: "medium",
    reason: "RegExp compiled at runtime — hoist to module scope if used in a loop",
    types: ["performance"],
  },
  {
    name: "array-find-linear",
    pattern: /\bObject\.keys\s*\([^)]+\)\s*\.(?:find|filter|forEach|map)\s*\(/,
    category: "Redundant Iteration",
    severity: "low",
    reason: "Object.keys() + iteration on hot path — consider using a Map for O(1) lookup",
    types: ["performance"],
  },
];

// ─── Analysis ─────────────────────────────────────────────────────────────────

function shouldSkipFile(filePath: string): boolean {
  // Test / mock infrastructure — too many intentional patterns
  if (
    /\.(test|spec)\.[jt]sx?$/.test(filePath) ||
    filePath.includes("__tests__") ||
    filePath.includes("/__mocks__/") ||
    filePath.includes("/fixtures/")
  ) return true;
  // Documentation and config files — pattern matches are almost always prose
  if (/\.(md|mdx|txt|rst|adoc)$/.test(filePath)) return true;
  if (/\.(json|yaml|yml|toml|ini|env)$/.test(filePath)) return true;
  return false;
}

/** Returns true for lines that are purely comments and should not be scanned. */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return (
    t.startsWith("//") ||   // single-line JS/TS/Go/Rust/Java comment
    t.startsWith("*") ||    // JSDoc / block comment body
    t.startsWith("/*") ||   // block comment open
    t.startsWith("#") ||    // Python / shell / TOML comment
    t.startsWith("<!--")    // HTML / markdown comment
  );
}

function analyzeChunk(chunk: Chunk, heuristics: Heuristic[]): TriageMatch[] {
  const matches: TriageMatch[] = [];
  const lines = chunk.content.split("\n");
  // Pre-compute which lines are comments so we skip them consistently
  const commentMask = lines.map(isCommentLine);
  // Build a comment-stripped version of the chunk for guard-pattern and
  // multi-line fallback checks — avoids guard/pattern matches inside comments.
  const strippedContent = lines
    .filter((_, i) => !commentMask[i])
    .join("\n");
  const seen = new Set<string>();

  for (const h of heuristics) {
    if (seen.has(h.name)) continue;

    // guardPattern: if present and matches, the finding is suppressed (call is guarded).
    if (h.guardPattern?.test(strippedContent)) continue;
    // requirePattern: if present and does NOT match, the finding is suppressed
    // (required context is absent — e.g. no loop present for sync-io-in-loop).
    if (h.requirePattern && !h.requirePattern.test(strippedContent)) continue;

    // Per-line matching — gives accurate absolute line numbers.
    // Comment lines are skipped so patterns in prose/JSDoc don't trigger.
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (commentMask[i]) continue;
      if (h.pattern.test(lines[i])) {
        seen.add(h.name);
        matches.push({
          heuristic: h.name,
          category: h.category,
          severity: h.severity,
          reason: h.reason,
          line: chunk.start + i,
          snippet: lines[i].trim().slice(0, 120),
        });
        found = true;
        break;
      }
    }

    // Multi-line fallback for patterns that genuinely span lines.
    // multiline:true  → raw content (empty-catch: a comment-only body IS a bug)
    // multiline:false → strippedContent (avoids matching patterns inside JSDoc)
    const fallbackContent = h.multiline ? chunk.content : strippedContent;
    if (!found && h.pattern.test(fallbackContent)) {
      seen.add(h.name);
      matches.push({
        heuristic: h.name,
        category: h.category,
        severity: h.severity,
        reason: h.reason,
        line: chunk.start,
        snippet: chunk.content.trim().slice(0, 120),
      });
    }
  }

  return matches;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

const SEV_STYLE: Record<Severity, (s: string) => string> = {
  high: (s) => chalk.red.bold(s),
  medium: (s) => chalk.yellow(s),
  low: (s) => chalk.gray(s),
};

function formatTerminal(findings: TriageFinding[], types: TriageType[]): void {
  const totalMatches = findings.reduce((n, f) => n + f.matches.length, 0);
  console.log(chalk.bold.cyan(`\n── vemora triage [${types.join(", ")}] ──────────────────────────`));
  console.log(chalk.gray(`   ${findings.length} chunk(s) flagged · ${totalMatches} pattern match(es)\n`));

  if (findings.length === 0) {
    console.log(chalk.green("  No issues found.\n"));
    return;
  }

  for (const f of findings) {
    const scoreLabel = chalk.bold(`score ${f.score}`);
    const symbolLabel = f.symbol ? chalk.gray(` [${f.symbol}]`) : "";
    console.log(
      `${chalk.bold.white(f.file)}:${chalk.cyan(String(f.startLine))}–${f.endLine}${symbolLabel}  ${scoreLabel}`,
    );
    for (const m of f.matches) {
      const sev = SEV_STYLE[m.severity](`[${m.severity}]`);
      console.log(`  ${sev} ${chalk.bold(m.category)}  ${chalk.gray(`line ${m.line}`)}`);
      console.log(`  ${m.reason}`);
      if (m.snippet) console.log(chalk.gray(`  > ${m.snippet}`));
    }
    console.log();
  }

  const bySev: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    for (const m of f.matches) bySev[m.severity]++;
  }
  const summary = (["high", "medium", "low"] as Severity[])
    .filter((s) => bySev[s] > 0)
    .map((s) => SEV_STYLE[s](`${bySev[s]} ${s}`))
    .join(chalk.gray(" · "));

  console.log(chalk.bold.cyan("────────────────────────────────────────────────────────────"));
  console.log(`  ${summary || chalk.green("0 issues")}`);
  console.log();
}

function formatMarkdown(findings: TriageFinding[], types: TriageType[]): string {
  const totalMatches = findings.reduce((n, f) => n + f.matches.length, 0);
  const lines: string[] = [
    `# Triage Report — ${types.join(", ")}`,
    "",
    `**Chunks flagged:** ${findings.length}  **Pattern matches:** ${totalMatches}`,
    "",
  ];

  if (findings.length === 0) {
    lines.push("No issues found.");
    return lines.join("\n");
  }

  const bySev: Partial<Record<Severity, TriageFinding[]>> = {};
  for (const f of findings) {
    const topSev = f.matches.reduce<Severity>(
      (best, m) => (SEVERITY_SCORE[m.severity] > SEVERITY_SCORE[best] ? m.severity : best),
      "low",
    );
    (bySev[topSev] ??= []).push(f);
  }

  for (const sev of ["high", "medium", "low"] as Severity[]) {
    const group = bySev[sev];
    if (!group?.length) continue;
    lines.push(`## ${sev.charAt(0).toUpperCase() + sev.slice(1)} (${group.length})`);
    lines.push("");
    for (const f of group) {
      const loc = f.symbol ? `${f.file}:${f.startLine} — ${f.symbol}` : `${f.file}:${f.startLine}`;
      lines.push(`### \`${loc}\``);
      for (const m of f.matches) {
        lines.push(`- **[${m.severity}] ${m.category}** (line ${m.line}): ${m.reason}`);
        if (m.snippet) lines.push(`  \`${m.snippet}\``);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ─── Main command ─────────────────────────────────────────────────────────────

export async function runTriage(
  rootDir: string,
  options: TriageOptions = {},
): Promise<void> {
  loadConfig(rootDir); // validates config exists

  const repo = new RepositoryStorage(rootDir);
  const chunks = repo.loadChunks();

  if (chunks.length === 0) {
    console.error(chalk.red("No index found. Run `vemora index` first."));
    process.exit(1);
  }

  const types = options.types ?? (["bugs", "security", "performance"] as TriageType[]);
  const topK = options.topK ?? 30;
  const minScore = options.minScore ?? 1;
  const output = options.output ?? "terminal";

  // Deduplicate heuristics by name (async-foreach appears in both bugs and performance)
  const applicable = HEURISTICS.filter((h) => h.types.some((t) => types.includes(t)));
  const deduped = [...new Map(applicable.map((h) => [h.name, h])).values()];

  // Filter by file substring if requested, and always skip test/mock files
  let targets = chunks.filter((c) => !shouldSkipFile(c.file));
  if (options.file) {
    const needle = options.file.toLowerCase();
    targets = targets.filter((c) => c.file.toLowerCase().includes(needle));
    if (targets.length === 0) {
      console.error(chalk.red(`No indexed chunks found for file filter: "${options.file}"`));
      process.exit(1);
    }
  }

  // Analyze
  const findings: TriageFinding[] = [];
  for (const chunk of targets) {
    const matches = analyzeChunk(chunk, deduped);
    if (matches.length === 0) continue;
    const score = matches.reduce((sum, m) => sum + SEVERITY_SCORE[m.severity], 0);
    if (score < minScore) continue;
    findings.push({ file: chunk.file, startLine: chunk.start, endLine: chunk.end, symbol: chunk.symbol, score, matches });
  }

  // Sort by score descending, slice to topK
  const sorted = findings.sort((a, b) => b.score - a.score).slice(0, topK);

  if (output === "json") {
    console.log(JSON.stringify({ types, findings: sorted }, null, 2));
  } else if (output === "markdown") {
    console.log(formatMarkdown(sorted, types));
  } else {
    formatTerminal(sorted, types);
  }
}

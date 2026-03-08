import type { SymbolIndex } from "../core/types";

// ─── tree-sitter (optional) ───────────────────────────────────────────────────
// tree-sitter native bindings are in optionalDependencies.
// If they fail to build (some CI environments, ARM, etc.) we fall back to regex.

let TreeSitterParser: (new () => TreeSitterParserInstance) | null = null;
let tsLanguage: unknown = null;
let tsxLanguage: unknown = null;
let jsLanguage: unknown = null;

interface TreeSitterParserInstance {
  setLanguage(lang: unknown): void;
  parse(src: string): { rootNode: TreeNode };
}

interface TreeNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: TreeNode[];
  namedChildren: TreeNode[];
  childForFieldName(name: string): TreeNode | null;
}

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  TreeSitterParser = require("tree-sitter");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const tsModule = require("tree-sitter-typescript");
  tsLanguage = tsModule.typescript;
  tsxLanguage = tsModule.tsx;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  jsLanguage = require("tree-sitter-javascript");
} catch {
  // tree-sitter not available — regex fallback will be used for all files
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ParsedSymbol {
  name: string;
  type:
    | "function"
    | "class"
    | "method"
    | "interface"
    | "type"
    | "constant"
    | "variable";
  startLine: number;
  endLine: number;
  exported: boolean;
  parent?: string;
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Parses a source file and returns all top-level symbols found.
 * Uses tree-sitter for TS/JS files when available; falls back to regex.
 */
export function parseSymbols(
  filePath: string,
  content: string,
): ParsedSymbol[] {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";

  if (TreeSitterParser) {
    try {
      if (ext === "ts") return parseWithTreeSitter(content, tsLanguage);
      if (ext === "tsx") return parseWithTreeSitter(content, tsxLanguage);
      if (ext === "js" || ext === "jsx")
        return parseWithTreeSitter(content, jsLanguage);
    } catch {
      // fall through to regex
    }
  }

  return parseWithRegex(content);
}

export function buildSymbolIndex(
  filePath: string,
  symbols: ParsedSymbol[],
): SymbolIndex {
  const index: SymbolIndex = {};
  for (const sym of symbols) {
    index[sym.name] = {
      type: sym.type,
      file: filePath,
      startLine: sym.startLine,
      endLine: sym.endLine,
      exported: sym.exported,
      parent: sym.parent,
    };
  }
  return index;
}

// ─── tree-sitter Parser ───────────────────────────────────────────────────────

function parseWithTreeSitter(
  content: string,
  language: unknown,
): ParsedSymbol[] {
  if (!TreeSitterParser || !language) return parseWithRegex(content);

  const parser = new TreeSitterParser();
  parser.setLanguage(language);
  const tree = parser.parse(content);
  const symbols: ParsedSymbol[] = [];
  visitNode(tree.rootNode, symbols, null, false);
  return symbols;
}

function visitNode(
  node: TreeNode,
  out: ParsedSymbol[],
  parentClass: string | null,
  insideExport: boolean,
): void {
  switch (node.type) {
    case "export_statement": {
      // Recurse into the declaration, marking it as exported
      for (const child of node.namedChildren) {
        visitNode(child, out, parentClass, true);
      }
      return;
    }

    case "function_declaration":
    case "generator_function_declaration": {
      const name = node.childForFieldName("name")?.text;
      if (name) {
        out.push({
          name: parentClass ? `${parentClass}.${name}` : name,
          type: "function",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: insideExport,
          parent: parentClass ?? undefined,
        });
      }
      // Don't recurse into function bodies for top-level symbol collection
      return;
    }

    case "class_declaration": {
      const name = node.childForFieldName("name")?.text;
      if (name) {
        out.push({
          name,
          type: "class",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: insideExport,
        });
        // Extract methods from class body
        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.namedChildren) {
            visitNode(child, out, name, false);
          }
        }
      }
      return;
    }

    case "method_definition": {
      const name = node.childForFieldName("name")?.text;
      if (name && parentClass && name !== "constructor") {
        out.push({
          name: `${parentClass}.${name}`,
          type: "method",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: false,
          parent: parentClass,
        });
      }
      return;
    }

    case "lexical_declaration":
    case "variable_declaration": {
      // const/let/var — check if the RHS is a function
      for (const child of node.namedChildren) {
        if (child.type === "variable_declarator") {
          const name = child.childForFieldName("name")?.text;
          const value = child.childForFieldName("value");
          if (!name) continue;

          if (
            value &&
            (value.type === "arrow_function" || value.type === "function")
          ) {
            out.push({
              name,
              type: "function",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              exported: insideExport,
            });
          } else if (insideExport && value) {
            out.push({
              name,
              type: "constant",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              exported: true,
            });
          }
        }
      }
      return;
    }

    case "interface_declaration": {
      const name = node.childForFieldName("name")?.text;
      if (name) {
        out.push({
          name,
          type: "interface",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: insideExport,
        });
      }
      return;
    }

    case "type_alias_declaration": {
      const name = node.childForFieldName("name")?.text;
      if (name) {
        out.push({
          name,
          type: "type",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: insideExport,
        });
      }
      return;
    }

    default:
      // Recurse into other top-level constructs (namespaces, modules, etc.)
      for (const child of node.namedChildren) {
        visitNode(child, out, parentClass, insideExport);
      }
  }
}

// ─── Regex Fallback Parser ────────────────────────────────────────────────────

/**
 * Estimates the end line of a symbol starting at `startIndex` (0-based).
 * Returns a 1-based line number.
 *
 * Strategy:
 *  1. Brace-counting — works for TS/JS/Rust/Go/C++ (any `{}`-delimited syntax).
 *  2. Indentation heuristic — fallback for Python and similar indent-based languages.
 *  3. Same-line fallback — if neither strategy applies (e.g. single-line constants).
 */
function findEndLine(lines: string[], startIndex: number): number {
  let depth = 0;
  let braceFound = false;

  for (let i = startIndex; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        braceFound = true;
      } else if (ch === "}") {
        depth--;
        if (braceFound && depth === 0) return i + 1; // 1-indexed
      }
    }
  }

  // No braces found — use indentation heuristic (Python, YAML-style, etc.)
  if (!braceFound) {
    const baseIndent = lines[startIndex].match(/^(\s*)/)?.[1].length ?? 0;
    for (let i = startIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue; // skip blank lines
      const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (indent <= baseIndent) return i; // i is 0-based next-block line → 1-based prev line
    }
    return lines.length; // EOF
  }

  return startIndex + 1; // fallback: same as start line
}

/**
 * Regex-based parser used as fallback for:
 *  - Non-TS/JS files (Python, Rust, Go, etc.)
 *  - When tree-sitter native bindings are unavailable
 */
function parseWithRegex(content: string): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  const lines = content.split("\n");

  const patterns: Array<{
    re: RegExp;
    type: ParsedSymbol["type"];
    exportGroup?: boolean;
  }> = [
    // TypeScript/JavaScript
    {
      re: /^(export\s+)?(async\s+)?function\s+(\w+)\s*[(<]/,
      type: "function",
      exportGroup: true,
    },
    {
      re: /^(export\s+)?(const|let)\s+(\w+)\s*=\s*(async\s+)?(\([^)]*\)|[^=])\s*=>/,
      type: "function",
      exportGroup: true,
    },
    {
      re: /^(export\s+)?(abstract\s+)?class\s+(\w+)/,
      type: "class",
      exportGroup: true,
    },
    {
      re: /^(export\s+)?interface\s+(\w+)/,
      type: "interface",
      exportGroup: true,
    },
    { re: /^(export\s+)?type\s+(\w+)\s*=/, type: "type", exportGroup: true },
    // Python
    { re: /^(async\s+)?def\s+(\w+)\s*\(/, type: "function" },
    { re: /^class\s+(\w+)(?:\s*:|\s*\()/, type: "class" },
    // Rust
    {
      re: /^(pub\s+)?(async\s+)?fn\s+(\w+)\s*[(<]/,
      type: "function",
      exportGroup: true,
    },
    { re: /^(pub\s+)?(struct|enum)\s+(\w+)/, type: "class", exportGroup: true },
    // Go
    { re: /^func\s+(\w+)\s*\(/, type: "function" },
    { re: /^type\s+(\w+)\s+(struct|interface)/, type: "class" },
  ];

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) return;

    for (const { re, type } of patterns) {
      const m = trimmed.match(re);
      if (m) {
        // Heuristic: find the captured group that looks like an identifier
        const name = m.slice(1).find((g) => g && /^\w+$/.test(g));
        if (
          name &&
          name !== "async" &&
          name !== "pub" &&
          name !== "abstract" &&
          name !== "struct" &&
          name !== "enum" &&
          name !== "const" &&
          name !== "let"
        ) {
          symbols.push({
            name,
            type,
            startLine: i + 1,
            endLine: findEndLine(lines, i),
            exported:
              trimmed.startsWith("export") ||
              trimmed.startsWith("pub ") ||
              trimmed.startsWith("pub("),
          });
          break;
        }
      }
    }
  });

  return symbols;
}

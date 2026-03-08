import type {
  CallGraph,
  CallGraphEntry,
  DependencyGraph,
  SymbolIndex,
} from "../core/types";

// Tree-sitter is optional, just like in parser.ts
// biome-ignore lint/suspicious/noExplicitAny: tree-sitter native bindings have no TS types
let Parser: any = null;
// biome-ignore lint/suspicious/noExplicitAny: tree-sitter native bindings have no TS types
let tsLanguage: any = null;

try {
  Parser = require("tree-sitter");
  const tsModule = require("tree-sitter-typescript");
  tsLanguage = tsModule.typescript || tsModule;
  // console.log('Tree-sitter loaded successfully');
} catch (_err) {
  // console.error('Failed to load Tree-sitter:', err);
}

export interface CallGraphContext {
  symbols: SymbolIndex;
  deps: DependencyGraph;
  allFiles: Set<string>;
}

/**
 * Extracts function calls from a file using Tree-sitter.
 * Returns a partial CallGraph for the given file.
 */
export function extractFileCalls(
  filePath: string,
  content: string,
  context: CallGraphContext,
): CallGraph {
  const fileCallGraph: CallGraph = {};

  if (!Parser || !tsLanguage || !filePath.match(/\.(ts|tsx|js|jsx)$/)) {
    return fileCallGraph;
  }

  const parser = new Parser();
  parser.setLanguage(tsLanguage);
  const tree = parser.parse(content);

  let currentScope: string | null = null; // file:symbol

  // biome-ignore lint/suspicious/noExplicitAny: tree-sitter AST node has no TS type
  function visit(node: any) {
    // 1. Track definition scope
    let newScopeDefined = false;
    if (
      node.type === "function_declaration" ||
      node.type === "method_definition"
    ) {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const name = nameNode.text;
        currentScope = `${filePath}:${name}`;
        if (!fileCallGraph[currentScope]) {
          fileCallGraph[currentScope] = { calls: [], calledBy: [] };
        }
        newScopeDefined = true;
      }
    } else if (node.type === "class_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        // Classes can call things in their constructor or field initializers,
        // but usually we care about methods. We'll set scope to class temporarily.
        const name = nameNode.text;
        currentScope = `${filePath}:${name}`;
        if (!fileCallGraph[currentScope]) {
          fileCallGraph[currentScope] = { calls: [], calledBy: [] };
        }
        newScopeDefined = true;
      }
    }

    // 2. Find calls
    if (node.type === "call_expression") {
      const functionNode = node.childForFieldName("function");
      if (functionNode && currentScope) {
        const callEntry = resolveCall(functionNode, filePath, context);
        if (callEntry) {
          fileCallGraph[currentScope].calls.push(callEntry);
        }
      }
    }

    // Recurse
    for (let i = 0; i < node.childCount; i++) {
      visit(node.child(i));
    }

    // Restore scope if we defined one here
    if (newScopeDefined) {
      // This is a simplification. Real scope tracking would need a stack.
      // But for top-level functions/methods it's mostly okay.
      currentScope = null;
    }
  }

  visit(tree.rootNode);
  return fileCallGraph;
}

function resolveCall(
  // biome-ignore lint/suspicious/noExplicitAny: tree-sitter AST node has no TS type
  node: any,
  currentFile: string,
  context: CallGraphContext,
): CallGraphEntry | null {
  const text = node.text;

  // Simple function call: foo()
  if (node.type === "identifier") {
    const name = text;
    // Heuristic 1: Is it in the same file?
    const _sameFileId = `${currentFile}:${name}`;
    if (context.symbols[name] && context.symbols[name].file === currentFile) {
      return { name, file: currentFile, line: context.symbols[name].startLine };
    }

    // Heuristic 2: Is it imported?
    const fileDeps = context.deps[currentFile];
    if (fileDeps) {
      for (const imp of fileDeps.imports) {
        if (imp.symbols.includes(name)) {
          // Found the file!
          const _targetSymbol = `${imp.file}:${name}`;
          // We might not have the exact line here without more lookup,
          // but we have the file.
          return { name, file: imp.file };
        }
      }
    }

    return { name };
  }

  // Method call: obj.method()
  if (node.type === "member_expression") {
    const propertyNode = node.childForFieldName("property");
    if (propertyNode) {
      const methodName = propertyNode.text;
      // Without type inference, we can only guess.
      // We return the method name at least.
      return { name: methodName };
    }
  }

  return null;
}

/**
 * Merges partial call graphs into a single global one and computes reverse edges.
 */
export function buildGlobalCallGraph(partials: CallGraph[]): CallGraph {
  const global: CallGraph = {};

  // 1. Merge calls
  for (const partial of partials) {
    for (const [callerId, data] of Object.entries(partial)) {
      if (!global[callerId]) {
        global[callerId] = { calls: [], calledBy: [] };
      }
      global[callerId].calls.push(...data.calls);
    }
  }

  // 2. Compute calledBy (in-edges)
  for (const [callerId, data] of Object.entries(global)) {
    for (const call of data.calls) {
      if (call.file) {
        const calleeId = `${call.file}:${call.name}`;
        if (!global[calleeId]) {
          global[calleeId] = { calls: [], calledBy: [] };
        }
        if (!global[calleeId].calledBy.includes(callerId)) {
          global[calleeId].calledBy.push(callerId);
        }
      }
    }
  }

  return global;
}

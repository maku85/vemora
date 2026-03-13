import type { TodoAnnotation } from "../core/types";

// Matches: // TODO: ..., # FIXME ..., /* HACK ... */, etc.
// Captures the keyword and the rest of the comment text on that line.
const TODO_RE = /\b(TODO|FIXME|HACK|XXX)\b[:\s]*(.*)/i;

/**
 * Scans the lines of a source file and returns all TODO/FIXME/HACK/XXX
 * annotations found in comments or inline text.
 *
 * Line numbers are 1-based to match editor conventions.
 */
export function extractTodos(
  relativePath: string,
  content: string,
): TodoAnnotation[] {
  const todos: TodoAnnotation[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(TODO_RE);
    if (match) {
      todos.push({
        file: relativePath,
        line: i + 1,
        type: match[1].toUpperCase() as TodoAnnotation["type"],
        text: match[2].trim(),
      });
    }
  }

  return todos;
}

import type { ChatMessage } from "./provider";

const TERSE_PREFIX =
  "Be terse. Drop pleasantries, preamble, filler words. Use fragments where clear. " +
  "Preserve all technical content unchanged: file paths, symbol names, code, commands.";

export function tersifyPrompt(systemContent: string): string {
  return `${TERSE_PREFIX}\n\n${systemContent}`;
}

export function withTerseConstraint(messages: ChatMessage[]): ChatMessage[] {
  const out = messages.map((m) => ({ ...m }));
  const sys = out.find((m) => m.role === "system");
  if (sys) {
    sys.content = tersifyPrompt(sys.content);
  } else {
    out.unshift({ role: "system", content: TERSE_PREFIX });
  }
  return out;
}

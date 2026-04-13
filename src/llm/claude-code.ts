import { spawn } from "child_process";
import type { ChatMessage, ChatOptions, LLMProvider, LLMResponse } from "./provider";

// ─── Provider ─────────────────────────────────────────────────────────────────

/**
 * LLMProvider that delegates to the local `claude` CLI in non-interactive mode.
 *
 * Unlike API-based providers, ClaudeCodeProvider runs a subprocess and can
 * grant the subprocess access to the project filesystem via its file tools
 * (Read, Grep, Glob). This lets the planner explore the codebase autonomously
 * rather than receiving pre-built context from vemora.
 *
 * Config example:
 * ```json
 * "planner": {
 *   "provider": "claude-code",
 *   "model": "claude-sonnet-4-6",
 *   "allowedTools": ["Read", "Grep", "Glob"],
 *   "maxBudgetUsd": 0.50
 * }
 * ```
 *
 * The `baseUrl` field is repurposed as the path to the `claude` binary
 * (default: "claude", assumed to be on PATH).
 */
export class ClaudeCodeProvider implements LLMProvider {
  readonly name = "claude-code";

  private readonly command: string;
  private readonly model: string | undefined;
  private readonly allowedTools: string[];
  private readonly maxBudgetUsd: number;

  constructor(options: {
    command?: string;
    model?: string;
    allowedTools?: string[];
    maxBudgetUsd?: number;
  } = {}) {
    this.command = options.command ?? "claude";
    this.model = options.model;
    this.allowedTools = options.allowedTools ?? ["Read", "Grep", "Glob"];
    this.maxBudgetUsd = options.maxBudgetUsd ?? 0.5;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<LLMResponse> {
    const projectRoot = options?.projectRoot ?? process.cwd();

    // ── Separate system message from conversation ─────────────────────────────
    const systemMsg = messages.find((m) => m.role === "system");
    const otherMsgs = messages.filter((m) => m.role !== "system");

    // Combine non-system messages into a single prompt string
    const prompt =
      otherMsgs.length === 1
        ? otherMsgs[0].content
        : otherMsgs.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");

    // ── Build argument list ───────────────────────────────────────────────────
    const args: string[] = [
      "-p", prompt,
      "--output-format", "text",
      "--allowedTools", this.allowedTools.join(","),
      "--max-budget-usd", String(this.maxBudgetUsd),
      "--dangerously-skip-permissions", // non-interactive: no permission prompts
    ];

    if (this.model) {
      args.push("--model", this.model);
    }

    if (systemMsg) {
      args.push("--append-system-prompt", systemMsg.content);
    }

    // ── Spawn subprocess ──────────────────────────────────────────────────────
    return new Promise<LLMResponse>((resolve, reject) => {
      const proc = spawn(this.command, args, {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(
            new Error(
              `claude CLI not found at "${this.command}". ` +
              "Install it with: npm install -g @anthropic-ai/claude-code",
            ),
          );
        } else {
          reject(err);
        }
      });

      proc.on("close", (code) => {
        if (code !== 0 && !stdout.trim()) {
          reject(
            new Error(
              `claude exited with code ${code}.\nstderr: ${stderr.trim()}`,
            ),
          );
          return;
        }

        // --output-format text: stdout is the raw assistant response
        resolve({ content: stdout.trim() });
      });
    });
  }
}

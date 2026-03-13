import { runInitAgent } from "./init-agent";

export interface InitClaudeOptions {
  /** Overwrite an existing CLAUDE.md (even if it has no vemora markers) */
  force?: boolean;
}

export async function runInitClaude(
  rootDir: string,
  options: InitClaudeOptions = {},
): Promise<void> {
  await runInitAgent(rootDir, { agents: ["claude"], force: options.force });
}

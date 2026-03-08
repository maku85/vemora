import chalk from "chalk";
import { SummaryStorage } from "../storage/summaries";

export async function runOverview(rootDir: string): Promise<void> {
  const summaryStorage = new SummaryStorage(rootDir);
  const projectSummary = summaryStorage.loadProjectSummary();

  if (!projectSummary) {
    console.log(
      chalk.yellow(
        "No project overview found. Run `ai-memory summarize` first.",
      ),
    );
    process.exit(1);
  }

  console.log(projectSummary.overview);
  console.log();
  console.log(chalk.gray(`Generated: ${projectSummary.generatedAt}`));
}

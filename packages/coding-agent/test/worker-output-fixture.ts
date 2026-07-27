import type { ParsedWorkerOutput } from "../src/core/delegation/worker-runner.ts";

type WorkerFinding = ParsedWorkerOutput["findings"][number];
type CompletedWorkerOutput = Pick<ParsedWorkerOutput, "summary" | "status"> &
	Partial<Pick<ParsedWorkerOutput, "findings">>;

/** Build a minimal successful response that stays coupled to the production worker envelope. */
export function completedWorkerOutput(summary: string, findings?: readonly WorkerFinding[]): string {
	const output = {
		summary,
		status: "completed",
		...(findings ? { findings: [...findings] } : {}),
	} satisfies CompletedWorkerOutput;
	return JSON.stringify(output);
}

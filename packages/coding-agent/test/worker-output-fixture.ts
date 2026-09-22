import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import type { AssistantMessage } from "@caupulican/pi-ai/types";
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

/** A verifier's acceptance rests on its own inspection: one successful read of the subject first. */
export function verifierInspection(cwd: string): AssistantMessage {
	writeFileSync(join(cwd, "subject.txt"), "verified subject\n");
	return fauxAssistantMessage([fauxToolCall("read", { path: "subject.txt" })], { stopReason: "toolUse" });
}

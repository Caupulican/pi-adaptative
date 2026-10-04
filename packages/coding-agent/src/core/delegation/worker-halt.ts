import type { AgentHaltRequest } from "../../kernel/index.ts";

/** Longest parent reason carried into the worker's transcript and the claim. */
export const MAX_WORKER_HALT_REASON_CHARS = 1_000;

const HALT_CLOSING_PROMPT = [
	"HALT CLOSING TURN",
	"The parent interrupted this worker. No tools are available in this final request.",
	"Write one concise factual report for the parent: completed work, unfinished work, the exact state of anything you touched, and the safest next step.",
	"Do not claim unperformed work. Do not emit a tool call or tool-call markup.",
].join("\n");

export function normalizeWorkerHaltReason(reason: string | undefined): string | undefined {
	const trimmed = reason?.trim();
	if (!trimmed) return undefined;
	return trimmed.length > MAX_WORKER_HALT_REASON_CHARS
		? `${trimmed.slice(0, MAX_WORKER_HALT_REASON_CHARS)}…`
		: trimmed;
}

/** What the worker is told, and the closing instruction its one tool-free request runs under. */
export function buildWorkerHaltRequest(reason: string | undefined): AgentHaltRequest {
	return {
		userMessage: [
			"[Worker control halt]",
			`The parent stopped your work${reason ? `: ${reason}` : "."}`,
			"Do not continue the task. Reply now with your report for the parent: what you finished, what is unfinished, the exact state of anything you touched, and what you would do next.",
		].join("\n"),
		closingPrompt: HALT_CLOSING_PROMPT,
	};
}

type LaneHalt = { reason: string | undefined; delivered: boolean; deadline: ReturnType<typeof setTimeout> | undefined };

/**
 * One halt per running lane, requested by the parent and taken exactly once by that lane's loop.
 * A halt the loop never reaches (the run finished first, or a tool outlived the deadline) is the
 * host's to settle: the deadline callback runs once, and clearing the lane removes the entry.
 */
export class WorkerLaneHalts {
	private readonly halts = new Map<string, LaneHalt>();

	/** False when this lane already has a halt in flight. */
	request(laneId: string, reason: string | undefined, deadlineMs: number, onDeadline: () => void): boolean {
		if (this.halts.has(laneId)) return false;
		const deadline = setTimeout(() => {
			const halt = this.halts.get(laneId);
			if (!halt || halt.delivered) return;
			halt.deadline = undefined;
			onDeadline();
		}, deadlineMs);
		deadline.unref?.();
		this.halts.set(laneId, { reason, delivered: false, deadline });
		return true;
	}

	/**
	 * Hands the request to a loop that has reached its boundary and stops the deadline. It stays
	 * available until the lane ends: a run the host re-attempts after a transient provider failure
	 * must halt again, not carry on with the task it was told to stop.
	 */
	take(laneId: string): AgentHaltRequest | undefined {
		const halt = this.halts.get(laneId);
		if (!halt) return undefined;
		halt.delivered = true;
		clearTimeout(halt.deadline);
		halt.deadline = undefined;
		return buildWorkerHaltRequest(halt.reason);
	}

	has(laneId: string): boolean {
		return this.halts.has(laneId);
	}

	/** The reason the parent gave, once the loop has taken the halt. */
	deliveredReason(laneId: string): { reason: string | undefined } | undefined {
		const halt = this.halts.get(laneId);
		return halt?.delivered ? { reason: halt.reason } : undefined;
	}

	clear(laneId: string): void {
		const halt = this.halts.get(laneId);
		if (!halt) return;
		clearTimeout(halt.deadline);
		this.halts.delete(laneId);
	}
}

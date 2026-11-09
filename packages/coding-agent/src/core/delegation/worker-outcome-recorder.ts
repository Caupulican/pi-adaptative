import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import { defineMachine, type MachineObserver, observeMachine, registerMachine } from "../../kernel/machine-spec.ts";
import { workerOutcomeDigestFile } from "../agent-paths.ts";
import type { WorkerClaim } from "../autonomy/contracts.ts";
import type { LaneStatus } from "../autonomy/lane-tracker.ts";
import { withSessionBundleAdmission } from "../orchestration/session-bundle-lifecycle.ts";
import type { DurableTaskRuntime } from "../orchestration/task-runtime.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import { writeFileAtomicSync } from "../util/atomic-file.ts";
import { boundedText } from "../util/bounded-line.ts";
import type { OutcomeLadderContext } from "./worker-escalation-facts.ts";
import {
	OUTCOME_LIMITS,
	OUTCOME_STATUSES,
	type Outcome,
	type OutcomeDigest,
	type OutcomeStatus,
	type ProjectOutcomeInput,
	projectOutcome,
	publishOutcome,
	sameOutcomeAttempt,
	sameOutcomeContent,
} from "./worker-outcome.ts";

type OutcomeMachineState = "none" | OutcomeStatus;

const EVERY_STATUS: Partial<Record<OutcomeStatus, OutcomeMachineState>> = Object.fromEntries(
	OUTCOME_STATUSES.map((status) => [status, status]),
);

/**
 * The outcome of one attempt. A first outcome may be any status; partial, blocked and failed may be re-decided (a
 * verification settles, a later fact arrives); succeeded and cancelled are final for that attempt.
 */
export const WORKER_OUTCOME_MACHINE = defineMachine<OutcomeMachineState, OutcomeStatus>({
	name: "worker-outcome",
	states: ["none", ...OUTCOME_STATUSES],
	initial: "none",
	transitions: {
		none: EVERY_STATUS,
		partial: EVERY_STATUS,
		blocked: EVERY_STATUS,
		failed: EVERY_STATUS,
		succeeded: {},
		cancelled: {},
	},
	describe: {
		none: "no outcome yet",
		succeeded: "done",
		partial: "partly done",
		blocked: "blocked",
		failed: "failed",
		cancelled: "stopped",
	},
});

/** Room the nonce fence and its attributes take around one fenced value. */
const DIGEST_FENCE_CHARS = 320;

let outcomeObserver: MachineObserver<OutcomeMachineState> | undefined;

/** One process-wide observer: outcomes of every session's workers share the one machine definition. */
function observer(): MachineObserver<OutcomeMachineState> {
	if (!outcomeObserver) {
		outcomeObserver = observeMachine(WORKER_OUTCOME_MACHINE);
		registerMachine(outcomeObserver);
	}
	return outcomeObserver;
}

/**
 * Records task outcomes for one session's worker lifecycle: projects the outcome from durable facts, writes it through
 * the runtime when its content changed, persists its bounded digest, reports the transition to the outcome machine and
 * notifies subscribers. Every write follows a durable terminal fact the lifecycle just committed.
 */
export class WorkerOutcomeRecorder {
	private readonly runtime: DurableTaskRuntime;
	private readonly agentDir: string;
	private readonly sessionId: string;
	private readonly now: () => number;
	private ladder: OutcomeLadderContext | undefined;

	constructor(options: { runtime: DurableTaskRuntime; agentDir: string; sessionId: string; now?: () => number }) {
		this.runtime = options.runtime;
		this.agentDir = options.agentDir;
		this.sessionId = options.sessionId;
		this.now = options.now ?? Date.now;
	}

	/** The facts the escalation ladder reads beyond the journal; returns the release that restores the defaults. */
	useLadderContext(context: OutcomeLadderContext): () => void {
		this.ladder = context;
		return () => {
			if (this.ladder === context) this.ladder = undefined;
		};
	}

	/**
	 * Record the outcome of one terminal attempt; `claim` is the host-normalized claim when the terminal path holds it.
	 * `facts` carries what the host learned after the attempt ended (requirement checks, a judgment pair).
	 */
	record(
		attemptId: string,
		claim?: WorkerClaim,
		facts?: Pick<ProjectOutcomeInput, "requirementChecks" | "ownerOnly">,
	): Outcome | undefined {
		const taskId = this.runtime.getSnapshot().attempts[attemptId]?.taskId;
		if (taskId === undefined) return undefined;
		let from: OutcomeMachineState = "none";
		const recorded = this.runtime.recordTaskOutcome(taskId, ({ snapshot, generation, outcomeId, previous }) => {
			const projected = projectOutcome({
				snapshot,
				attemptId,
				...(claim ? { claim } : {}),
				generation,
				outcomeId,
				...(previous ? { previous } : {}),
				recordedAt: new Date(this.now()).toISOString(),
				...(this.ladder ? { ladder: this.ladder } : {}),
				...facts,
			});
			if (!projected) return undefined;
			const prior = sameOutcomeAttempt(previous, attemptId);
			if (prior && sameOutcomeContent(prior, projected)) return undefined;
			from = prior?.status ?? "none";
			const digestRef = this.writeDigest(projected, snapshot.attempts[attemptId], claim);
			return digestRef ? { ...projected, digestRef } : projected;
		});
		if (!recorded) return undefined;
		observer().record(from, recorded.status, recorded.blocker);
		publishOutcome(recorded);
		return recorded;
	}

	/**
	 * Record the attempt's outcome when the stored one does not describe it at its current lane status: a terminal fact
	 * committed outside the lifecycle (recovery, objective cancellation, lease expiry) or a journal written before
	 * outcomes existed. Reads the given snapshot only, so polling a settled lane writes nothing. Returns whether it wrote.
	 */
	ensure(snapshot: TaskRuntimeProjection, attempt: AttemptRuntimeState, laneStatus: LaneStatus): boolean {
		const stored = sameOutcomeAttempt(snapshot.tasks[attempt.taskId]?.outcome, attempt.attemptId);
		if (stored && stored.attempts.at(-1)?.laneStatus === laneStatus) return false;
		return this.record(attempt.attemptId) !== undefined;
	}

	/** The bounded digest beside the outcome; a write failure is logged and the outcome stands without a pointer. */
	private writeDigest(
		outcome: Outcome,
		attempt: AttemptRuntimeState | undefined,
		claim: WorkerClaim | undefined,
	): string | undefined {
		const words = claim?.summary ?? attempt?.result?.summary ?? "";
		const source = `worker-outcome:${outcome.taskId ?? outcome.nodeId}`;
		// Each worker value is fenced; the bound covers the fenced value, so the words keep room for the fence.
		const fenced = (value: string, maxChars: number): string =>
			wrapUntrustedText(boundedText(value, Math.max(64, maxChars - DIGEST_FENCE_CHARS)), source);
		const digest: OutcomeDigest = {
			v: 1,
			outcomeId: outcome.outcomeId,
			summary: words ? fenced(words, OUTCOME_LIMITS.digestSummaryChars) : "",
			...(claim?.blockers?.[0]
				? {
						blockerDetail: fenced(claim.blockers[0], OUTCOME_LIMITS.digestBlockerDetailChars),
					}
				: {}),
			findings: (claim?.evidence?.findings ?? []).slice(0, OUTCOME_LIMITS.digestFindings).map((finding) => ({
				summary: fenced(finding.summary, OUTCOME_LIMITS.digestSummaryChars / 4),
				confidence: finding.confidence ?? 0,
				cites: finding.evidenceIds.slice(0, 8).map((cite) => boundedText(cite, OUTCOME_LIMITS.maxStringChars)),
			})),
			...(claim?.commandReceipts && claim.commandReceipts.length > 0
				? {
						receipts: claim.commandReceipts.slice(-OUTCOME_LIMITS.digestReceipts).map((receipt) => ({
							command: boundedText(receipt.command, OUTCOME_LIMITS.maxStringChars),
							...(receipt.exitCode !== undefined ? { exitCode: receipt.exitCode } : {}),
							isError: receipt.isError,
						})),
					}
				: {}),
		};
		const text = JSON.stringify(digest);
		if (Buffer.byteLength(text, "utf8") > OUTCOME_LIMITS.digestMaxBytes) {
			harnessLog.warn("outcomes", "an outcome digest exceeded its bound and was not written", () => ({
				outcomeId: outcome.outcomeId,
			}));
			return undefined;
		}
		try {
			const filePath = workerOutcomeDigestFile(
				this.agentDir,
				this.sessionId,
				createHash("sha256").update(outcome.outcomeId).digest("hex"),
			);
			return withSessionBundleAdmission(this.agentDir, this.sessionId, () => {
				const directory = dirname(filePath);
				mkdirSync(directory, { recursive: true, mode: 0o700 });
				if (process.platform !== "win32") chmodSync(directory, 0o700);
				writeFileAtomicSync(filePath, text, { mode: 0o600 });
				return filePath;
			});
		} catch (error) {
			harnessLog.warn("outcomes", "an outcome digest could not be written", () => ({
				outcomeId: outcome.outcomeId,
				error: error instanceof Error ? error.message : String(error),
			}));
			return undefined;
		}
	}
}

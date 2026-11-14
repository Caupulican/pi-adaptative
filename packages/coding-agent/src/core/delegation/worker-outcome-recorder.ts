import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import { type MachineObserver, observeMachine, registerMachine } from "../../kernel/machine-spec.ts";
import { type OrchestrationHome, workerOutcomeDigestFile } from "../agent-paths.ts";
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
	type Outcome,
	type OutcomeDigest,
	type ProjectOutcomeInput,
	projectOutcome,
	publishOutcome,
	sameOutcomeAttempt,
	sameOutcomeContent,
} from "./worker-outcome.ts";
import { type OutcomeMachineState, WORKER_OUTCOME_MACHINE } from "./worker-outcome-machine.ts";

/** Room the nonce fence and its attributes take around one fenced value. */
const DIGEST_FENCE_CHARS = 320;

/**
 * One outcome observer per session, listed in that session's status view. A session's lifecycles are built often and
 * transiently (setup reads, placement checks), so the observer belongs to the session, not to a lifecycle: a lifecycle
 * that never records an outcome leaves no entry, and a session's entry is released when the session closes.
 */
const sessionObservers = new Map<
	string,
	{ readonly observer: MachineObserver<OutcomeMachineState>; readonly unregister: () => void }
>();

function sessionObserver(sessionId: string): MachineObserver<OutcomeMachineState> {
	let entry = sessionObservers.get(sessionId);
	if (!entry) {
		const observer = observeMachine(WORKER_OUTCOME_MACHINE, { entities: true });
		entry = { observer, unregister: registerMachine(observer, sessionId) };
		sessionObservers.set(sessionId, entry);
	}
	return entry.observer;
}

/**
 * A closing session gives up its outcome observer: the entry here and its registration in the machine registry. Left in
 * place, both would keep every task state the session recorded for the life of the process.
 */
function releaseSessionOutcomeObserver(sessionId: string): void {
	const entry = sessionObservers.get(sessionId);
	if (!entry) return;
	sessionObservers.delete(sessionId);
	entry.unregister();
}

/**
 * Records task outcomes for one session's worker lifecycle: projects the outcome from durable facts, writes it through
 * the runtime when its content changed, persists its bounded digest, reports the transition to the outcome machine and
 * notifies subscribers. Every write follows a durable terminal fact the lifecycle just committed.
 */
export class WorkerOutcomeRecorder {
	private readonly runtime: DurableTaskRuntime;
	private readonly orchestrationHome: OrchestrationHome;
	private readonly sessionId: string;
	private readonly now: () => number;
	private ladder: OutcomeLadderContext | undefined;

	constructor(options: {
		runtime: DurableTaskRuntime;
		orchestrationHome: OrchestrationHome;
		sessionId: string;
		now?: () => number;
	}) {
		this.runtime = options.runtime;
		this.orchestrationHome = options.orchestrationHome;
		this.sessionId = options.sessionId;
		this.now = options.now ?? Date.now;
	}

	/** The session is closing: its outcome observer is released (a later record would start a fresh one). */
	releaseObserver(): void {
		releaseSessionOutcomeObserver(this.sessionId);
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
	 * `facts` carries what the host learned after the attempt ended (requirement checks, rung refusal).
	 */
	record(
		attemptId: string,
		claim?: WorkerClaim,
		facts?: Pick<ProjectOutcomeInput, "requirementChecks" | "rungRefusal">,
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
		sessionObserver(this.sessionId).record(from, recorded.status, recorded.blocker);
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
				this.orchestrationHome,
				this.sessionId,
				createHash("sha256").update(outcome.outcomeId).digest("hex"),
			);
			return withSessionBundleAdmission(this.orchestrationHome, this.sessionId, () => {
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

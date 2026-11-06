import type {
	CiAttemptIdentity,
	CiAttemptTerminalEvent,
	CiCurrentObservation,
	CiSubject,
} from "../../core/events/host-event-contract.ts";
import type { CiFailureEvidence } from "../../core/proactivity/act-ahead-record.ts";

export interface CiRepository {
	readonly host: string;
	readonly repositoryId: number;
	readonly nameWithOwner: string;
	readonly workflowId: number;
	readonly workflowPath: string;
}

export interface CiProviderCollection {
	readonly subject: CiSubject;
	readonly events: readonly CiAttemptTerminalEvent[];
	readonly current?: CiCurrentObservation;
	/** The newest run's custody was retired: no current attempt can be proven for this subject. */
	readonly predatesRetention?: true;
}

export interface CiRetiredRunRange {
	readonly from: number;
	readonly through: number;
}

/** Only the adapter knows GitHub or starts a process; reconciliation consumes typed facts. */
export interface CiProvider {
	repository(signal: AbortSignal): Promise<CiRepository>;
	collect(
		headSha: string,
		signal: AbortSignal,
		retainedAttempts?: ReadonlyMap<number, number>,
		retiredRuns?: readonly CiRetiredRunRange[],
	): Promise<CiProviderCollection>;
	failedJobs(identity: CiAttemptIdentity, signal: AbortSignal): Promise<readonly string[]>;
	/** Read-only evidence of a failed attempt; an adapter without it gives none (acting ahead then needs reproduction). */
	failureEvidence?(identity: CiAttemptIdentity, signal: AbortSignal): Promise<CiFailureEvidence>;
	waitForRun(runId: number, signal: AbortSignal): Promise<void>;
}

export interface CiCommandPort {
	run(executable: string, args: readonly string[], signal: AbortSignal): Promise<string>;
	/** Long-lived commands: output is discarded, only the exit status and a bounded error tail count. */
	wait(executable: string, args: readonly string[], signal: AbortSignal): Promise<void>;
	/** Bounded reads: only the last `maxChars` of the output are held, never the whole of it. */
	tail(executable: string, args: readonly string[], signal: AbortSignal, maxChars: number): Promise<string>;
}

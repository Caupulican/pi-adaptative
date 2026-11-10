/**
 * The events outside the dispatch queue that wake it: the owner's continue after a machine-wide emergency stop, and
 * every effective-settings transition.
 *
 * A queued start is decided against the fleet settings as they read at that moment. Without a wake, a setting the owner
 * raises (a running ceiling, a budget, a provider limit) is only seen at the next worker terminal, turn end or retained
 * release, which is where the raise no longer matters. Every wake is one idempotent drain of the queue: it re-decides
 * each waiting start and fixes its wait reason, and the scheduler folds a wake that arrives during a pass into that pass.
 */
import { harnessLog } from "../../kernel/harness-log.ts";
import { isEmergencyStopEngaged, subscribeOwnerContinue } from "../provider-admission/emergency-stop.ts";

/** What a queue wake needs from its owner: the machine-wide records, whether it may still act, and what to do. */
export interface WorkerQueueWakeDeps {
	/** The owner's directory, which the emergency stop and the resume record live in. */
	agentDir(): string;
	/** Whether the controller has shut down; a wake that arrives after it changes nothing. */
	isClosed(): boolean;
	/** Lifts the fleet's spend brake and ramps the account windows before the queue decides starts again. */
	resumeFleet(): void;
	/** Re-decides every queued start against the current settings and the current room. */
	drainQueue(reservationAvailable: boolean): void;
	/** Reports a wake that failed, without failing the caller that announced the change. */
	warn(message: string): void;
}

/** The settings a wake reads: every effective-settings transition, from a setter or from a reload, is announced. */
export interface WorkerQueueWakeSettings {
	subscribeChanges(listener: () => void): () => void;
}

/**
 * Re-decides the waiting starts after an owner continue and after every settings change, and returns the release of
 * both subscriptions. The caller releases it with its other subscriptions, so no wake outlives the queue.
 */
export function startWorkerQueueWakes(deps: WorkerQueueWakeDeps, settings: WorkerQueueWakeSettings): () => void {
	const stopOwnerContinue = subscribeOwnerContinue(deps.agentDir(), () => {
		if (isEmergencyStopEngaged(deps.agentDir())) return;
		if (deps.isClosed()) return;
		harnessLog.info("delegation", "queued workers were woken by the owner's continue");
		// The continue runs this synchronously inside the caller's `liftEmergencyStop`: a failed wake never fails it.
		try {
			deps.resumeFleet();
			// A stop froze the work that held a write reservation, so the continue offers the queue that one may be free.
			deps.drainQueue(true);
		} catch (error) {
			deps.warn(`Worker queue wake after the owner's continue failed: ${failureText(error)}`);
		}
	});
	// A settings change is announced synchronously inside the setter or the reload that made it, so this drain can run
	// inside a turn or inside another drain. A drain that arrives during a pass is folded into that pass, and a drain
	// that finds no room starts nothing: the wake never waits on a clock and never runs a second pass in parallel.
	const stopSettingsChanges = settings.subscribeChanges(() => {
		if (deps.isClosed()) return;
		try {
			deps.drainQueue(false);
		} catch (error) {
			deps.warn(`Worker queue wake after a settings change failed: ${failureText(error)}`);
		}
	});
	return () => {
		stopOwnerContinue();
		stopSettingsChanges();
	};
}

function failureText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

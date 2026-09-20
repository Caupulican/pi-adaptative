/**
 * System One's two levers over the foreground turn, the same two the operator has: cancel fires
 * immediately (the Esc path: the running turn aborts under a named reason), and a steer is either
 * queued for the next model turn or delivered now by interrupting the running turn and sending it.
 *
 * Both may be invoked from inside the running turn (the tool gate runs on the agent loop's own call
 * stack), so neither waits for the loop to finish: cancel returns as soon as the abort is signalled,
 * and a steer delivered "now" schedules its own submission for when the foreground is idle.
 */

export type SystemOneSteerDelivery = "queue" | "now";

export interface SystemOneForegroundControl {
	/** Abort the running turn at once under `reason`; a no-op when nothing is running. */
	cancelTurn(reason: string): void;
	/** Queue `text` for the next model turn, or interrupt the running turn and send it now. */
	steer(text: string, delivery: SystemOneSteerDelivery): Promise<void>;
}

export interface SessionForegroundControlDeps {
	abortTurn(reason: string): void;
	isTurnRunning(): boolean;
	queueSteer(text: string): void;
	/** Every queued steering and follow-up text, drained, as one prompt. */
	takeQueuedText(): string;
	waitForForegroundIdle(): Promise<void>;
	prompt(text: string): Promise<void>;
	/** Every directive System One issues is an operator-visible event, never a silent one. */
	recordDirective(directive: string): void;
	emitWarning(message: string): void;
}

export const SYSTEM_ONE_ABORT_PREFIX = "system_one:";

export function createSessionForegroundControl(deps: SessionForegroundControlDeps): SystemOneForegroundControl {
	return {
		cancelTurn(reason) {
			deps.recordDirective(`cancel turn: ${reason}`);
			if (!deps.isTurnRunning()) return;
			deps.abortTurn(`${SYSTEM_ONE_ABORT_PREFIX}${reason}`);
		},
		async steer(text, delivery) {
			deps.recordDirective(`steer (${delivery}): ${text}`);
			deps.queueSteer(text);
			if (delivery === "queue" || !deps.isTurnRunning()) return;
			deps.abortTurn(`${SYSTEM_ONE_ABORT_PREFIX}steer now`);
			// The aborted turn holds the foreground lease until its tail finishes; the send follows it.
			void deps
				.waitForForegroundIdle()
				.then(() => {
					const queued = deps.takeQueuedText();
					return queued ? deps.prompt(queued) : undefined;
				})
				.catch((error: unknown) => {
					deps.emitWarning(
						`System One steer could not be sent: ${error instanceof Error ? error.message : String(error)}`,
					);
				});
		},
	};
}

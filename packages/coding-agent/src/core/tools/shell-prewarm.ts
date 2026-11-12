/** Deferred best-effort warm-up scheduling shared by local shell tiers. */

export type ShellPrewarmCallback = () => Promise<void>;
export type ShellPrewarmScheduler = (callback: ShellPrewarmCallback) => void;

function scheduleOnEventLoop(callback: ShellPrewarmCallback): void {
	setImmediate(() => {
		void callback().catch(() => undefined);
	});
}

/** Defer setup and absorb only warm-up failures; command execution keeps its own strict error path. */
export function scheduleShellPrewarm(scheduler: ShellPrewarmScheduler | undefined, prepare: () => Promise<void>): void {
	const callback: ShellPrewarmCallback = async () => {
		try {
			await prepare();
		} catch {
			// Startup warming is best-effort; the first real command reports actionable failures.
		}
	};
	try {
		(scheduler ?? scheduleOnEventLoop)(callback);
	} catch {
		// Failure to queue a warm-up has the same best-effort status as failure to perform it.
	}
}

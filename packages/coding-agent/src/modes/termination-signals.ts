import { killTrackedDetachedChildren } from "../utils/shell.ts";

export type TerminationSignalHandler = (exitCode: number, signal: NodeJS.Signals) => void;

/** Register the portable termination signals and return their deterministic cleanup. */
export function registerTerminationSignalHandlers(onSignal: TerminationSignalHandler): () => void {
	const cleanups: Array<() => void> = [];
	const signals: NodeJS.Signals[] = ["SIGTERM"];
	if (process.platform !== "win32") signals.push("SIGHUP");

	for (const signal of signals) {
		const handler = (): void => {
			killTrackedDetachedChildren();
			onSignal(signal === "SIGHUP" ? 129 : 143, signal);
		};
		process.on(signal, handler);
		cleanups.push(() => process.off(signal, handler));
	}

	return () => {
		for (const cleanup of cleanups) cleanup();
	};
}

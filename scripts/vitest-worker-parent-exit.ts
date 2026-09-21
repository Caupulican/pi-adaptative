/**
 * A Vitest fork whose parent runner has died keeps executing and can sit at a full core.
 * The runner's IPC close is the terminal signal. Exit on that signal.
 */
export function exitWhenVitestParentIsGone(): void {
	if (typeof process.send !== "function") return;
	const stop = (): void => {
		process.exit(1);
	};
	process.on("disconnect", stop);
	const timer = setInterval(() => {
		if (process.connected === false) stop();
	}, 1000);
	timer.unref();
}

exitWhenVitestParentIsGone();

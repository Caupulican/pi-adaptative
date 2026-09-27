import { spawn } from "node:child_process";
import type { PiSelfLaunchTarget } from "../core/process-matrix/resume-launcher.ts";
import type { RuntimeChild } from "../core/runtime-supervisor.ts";
import { parseRuntimeSupervisorMessage } from "./runtime-channel.ts";

/** Native process adapter. Output is never used as lifecycle evidence. */
export function launchRuntimeChild(
	target: PiSelfLaunchTarget,
	args: readonly string[],
	options: {
		cwd: string;
		env: NodeJS.ProcessEnv;
		terminal?: "inherit" | "ignore";
	},
): RuntimeChild {
	const terminalMode = options.terminal ?? "inherit";
	const child = spawn(target.executable, [...target.argsPrefix, ...args], {
		cwd: options.cwd,
		env: options.env,
		stdio: [terminalMode, terminalMode, terminalMode, "ipc"],
	});
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	let spawned = false;
	let stopRequested = false;
	let terminalSettled = false;
	const requestTermination = (): void => {
		if (terminalSettled || killTimer || child.exitCode !== null || child.signalCode !== null) return;
		killTimer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				// The terminal promise remains authoritative; a signal exception is not an exit.
			}
		}, 5000);
		try {
			child.kill("SIGTERM");
		} catch {
			// The bounded fallback retains termination ownership after a failed first signal.
		}
	};
	const terminal = new Promise<number>((resolve) => {
		const settleTerminal = (code: number): void => {
			if (terminalSettled) return;
			terminalSettled = true;
			clearTimeout(killTimer);
			child.off("spawn", onSpawn);
			resolve(code);
		};
		const onSpawn = (): void => {
			if (terminalSettled) return;
			spawned = true;
			if (stopRequested) requestTermination();
		};
		child.once("exit", (code) => settleTerminal(code ?? 1));
		child.once("spawn", onSpawn);
		// A failed spawn has no writer. Errors on an existing process (e.g. kill denied) do not
		// prove it stopped; only its terminal event may release the single-writer fence.
		child.on("error", () => {
			if (!spawned) settleTerminal(1);
		});
	});
	return {
		terminal,
		onMessage(listener) {
			const receive = (value: unknown) => {
				const message = parseRuntimeSupervisorMessage(value);
				if (message) listener(message);
			};
			child.on("message", receive);
			return () => child.off("message", receive);
		},
		send(message) {
			if (child.connected) child.send(message, () => {});
		},
		stop() {
			if (terminalSettled || stopRequested || child.exitCode !== null || child.signalCode !== null) return;
			stopRequested = true;
			// A failed spawn can retain a native handle before its error. Only the child's own
			// spawn event grants signal ownership; an earlier stop remains armed until then.
			if (spawned) requestTermination();
		},
	};
}

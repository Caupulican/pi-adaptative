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
	const terminal = new Promise<number>((resolve) => {
		child.once("exit", (code) => {
			clearTimeout(killTimer);
			resolve(code ?? 1);
		});
		// A failed spawn has no writer. Errors on an existing process (e.g. kill denied) do not
		// prove it stopped; only its terminal event may release the single-writer fence.
		child.on("error", () => {
			if (child.pid === undefined) {
				clearTimeout(killTimer);
				resolve(1);
			}
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
			if (killTimer || child.exitCode !== null || child.signalCode !== null) return;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
		},
	};
}

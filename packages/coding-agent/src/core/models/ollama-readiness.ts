import type { Socket } from "node:net";
import type { ManagedRuntimeChild } from "./runtime-process.ts";

/** Ollama emits this only after net.Listen succeeds (server/routes.go in the pinned release). */
export function waitForOllamaListener(child: ManagedRuntimeChild, baseUrl: string, timeoutMs: number): Promise<void> {
	const expected = new URL(baseUrl);
	const outputs = [child.stdout, child.stderr].filter((stream) => stream != null);
	if (outputs.length === 0) return Promise.reject(new Error("Ollama child has no readiness output"));
	return new Promise((resolve, reject) => {
		let done = false;
		const finish = (error?: Error) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve();
		};
		const timer = setTimeout(
			() => finish(new Error("Ollama did not announce a listener before the deadline")),
			timeoutMs,
		);
		const readStream = () => {
			let buffer = "";
			return (chunk: Buffer | string) => {
				if (done) return;
				buffer = (buffer + chunk.toString()).slice(-8192);
				for (const line of buffer.split("\n").slice(0, -1)) {
					const match = /Listening on (\[[^\]]+\]:\d+|[^\s:]+:\d+) \(version [^)]*\)/.exec(line);
					if (!match) continue;
					try {
						const actual = new URL(`http://${match[1]}`);
						if (actual.hostname === expected.hostname && actual.port === expected.port) finish();
						else finish(new Error(`Ollama announced an unexpected listener ${match[1]}`));
					} catch {
						finish(new Error("Ollama listener announcement was malformed"));
					}
				}
				const lastNewline = buffer.lastIndexOf("\n");
				if (lastNewline >= 0) buffer = buffer.slice(lastNewline + 1);
			};
		};
		for (const stream of outputs) {
			stream.on("data", readStream());
			(stream as Socket).unref?.();
		}
		child.on("error", (error: Error) => finish(new Error(`Ollama startup failed: ${error.message}`)));
		child.on("exit", (code: number | null) =>
			finish(new Error(`Ollama exited before listener readiness (${code ?? "signal"})`)),
		);
		if (child.exitCode !== null || child.signalCode !== null)
			finish(new Error("Ollama exited before listener readiness"));
	});
}

import { spawnProcess, waitForChildProcessWithTermination } from "../../utils/child-process.ts";
import type { ReadOperation } from "./read-operation-context.ts";

/** Native processing has a time/process/output budget, not a claim about internal OS reads. */
export async function runReadProcess(
	operation: ReadOperation,
	command: string,
	args: readonly string[],
	options: { cwd: string; env?: NodeJS.ProcessEnv; input?: Buffer; outputCap?: number },
): Promise<{ stdout: Buffer; stderr: Buffer; code: number | null; capped: boolean }> {
	operation.charge("processes", 1);
	const stop = new AbortController();
	const signal = AbortSignal.any([operation.signal, stop.signal]);
	const cap = Math.min(options.outputCap ?? 128 * 1024, operation.remaining("outputBytes"));
	if (cap <= 0) throw new Error("Read process output budget exhausted");
	const child = spawnProcess(command, [...args], {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let retained = 0;
	let capped = false;
	const receive = (target: Buffer[], chunk: Buffer) => {
		if (capped) return;
		const size = Math.min(chunk.length, cap - retained);
		try {
			operation.charge("outputBytes", size);
		} catch {
			capped = true;
			stop.abort();
			return;
		}
		if (size > 0) target.push(Buffer.from(chunk.subarray(0, size)));
		retained += size;
		if (size < chunk.length) {
			capped = true;
			stop.abort();
		}
	};
	child.stdout?.on("data", (chunk: Buffer) => receive(stdout, chunk));
	child.stderr?.on("data", (chunk: Buffer) => receive(stderr, chunk));
	child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
		// A bounded matcher may exit as soon as its requested match count is reached.
		if (error.code !== "EPIPE") stop.abort();
	});
	child.stdin?.end(options.input);
	const terminal = await waitForChildProcessWithTermination(child, {
		signal,
		timeoutMs: Math.max(1, operation.deadlineAt - Date.now()),
		killGraceMs: 1000,
	});
	operation.assertCurrent();
	if (terminal.reason !== "exited" && !capped) throw new Error("Read process did not complete within its budget");
	return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: terminal.code, capped };
}

import { spawnProcess, waitForChildProcessWithTermination } from "../../utils/child-process.ts";

export interface CollaborationCommandOptions {
	timeoutMs: number;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
}

export interface CollaborationCommandResult {
	code: number | null;
	reason: "exited" | "timeout" | "aborted" | "output_limit" | "not_found" | "spawn_error";
	stdout: string;
	stderr: string;
}

export type CollaborationCommandRunner = (
	executable: string,
	args: string[],
	options: CollaborationCommandOptions,
) => Promise<CollaborationCommandResult>;

/** Finite control/status commands only. A transport timeout never proves a remote turn was cancelled. */
export const runCollaborationCommand: CollaborationCommandRunner = async (executable, args, options) => {
	if (options.signal?.aborted) return { code: null, reason: "aborted", stdout: "", stderr: "" };
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let bytes = 0;
	let overflow = false;
	try {
		const child = spawnProcess(executable, args, {
			env: options.env,
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const collect = (chunks: Buffer[], chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 1024 * 1024) {
				overflow = true;
				controller.abort();
			} else chunks.push(chunk);
		};
		child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
		child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
		const terminal = await waitForChildProcessWithTermination(child, {
			signal: controller.signal,
			timeoutMs: options.timeoutMs,
			killGraceMs: 1000,
		});
		return {
			code: terminal.code,
			reason: overflow ? "output_limit" : terminal.reason,
			stdout: Buffer.concat(stdout).toString("utf8"),
			stderr: Buffer.concat(stderr).toString("utf8"),
		};
	} catch (error) {
		return {
			code: null,
			reason: error instanceof Error && "code" in error && error.code === "ENOENT" ? "not_found" : "spawn_error",
			stdout: "",
			stderr: "",
		};
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
	}
};

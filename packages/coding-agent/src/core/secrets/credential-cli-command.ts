import type { ChildProcess } from "node:child_process";
import { spawnProcess, waitForChildProcessWithTermination } from "../../utils/child-process.ts";

const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

export interface CredentialCliCommandRequest {
	executable: string;
	args: string[];
	input?: string;
	authEnvironment: { name: "BWS_ACCESS_TOKEN" | "BW_SESSION"; value: string };
	omitEnvironmentVariables?: readonly string[];
	signal?: AbortSignal;
}

export interface CredentialCliCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	aborted?: boolean;
	timedOut?: boolean;
	outputLimitExceeded?: boolean;
}

function appendBounded(current: string, chunk: Buffer | string): { value: string; exceeded: boolean } {
	const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
	if (Buffer.byteLength(current, "utf8") + Buffer.byteLength(text, "utf8") <= MAX_COMMAND_OUTPUT_BYTES) {
		return { value: current + text, exceeded: false };
	}
	return { value: current, exceeded: true };
}

function combineAbortSignal(source: AbortSignal | undefined, controller: AbortController): () => void {
	if (!source) return () => {};
	const abort = () => controller.abort();
	if (source.aborted) abort();
	else source.addEventListener("abort", abort, { once: true });
	return () => source.removeEventListener("abort", abort);
}

/** Shared bounded process boundary for Bitwarden provider adapters. */
export async function runCredentialCliCommand(
	request: CredentialCliCommandRequest,
): Promise<CredentialCliCommandResult> {
	const controller = new AbortController();
	const detachAbort = combineAbortSignal(request.signal, controller);
	let stdout = "";
	let stderr = "";
	let outputLimitExceeded = false;
	let child: ChildProcess;
	try {
		const environment = {
			...process.env,
			[request.authEnvironment.name]: request.authEnvironment.value,
			NO_COLOR: "1",
		};
		for (const name of request.omitEnvironmentVariables ?? []) delete environment[name];
		child = spawnProcess(request.executable, request.args, {
			env: environment,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		child.stdout?.on("data", (chunk: Buffer | string) => {
			const appended = appendBounded(stdout, chunk);
			stdout = appended.value;
			if (appended.exceeded) {
				outputLimitExceeded = true;
				controller.abort();
			}
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			const appended = appendBounded(stderr, chunk);
			stderr = appended.value;
			if (appended.exceeded) {
				outputLimitExceeded = true;
				controller.abort();
			}
		});
		child.stdin?.end(request.input);
		const terminal = await waitForChildProcessWithTermination(child, {
			signal: controller.signal,
			timeoutMs: COMMAND_TIMEOUT_MS,
			killGraceMs: 2_000,
		});
		return {
			exitCode: terminal.code ?? 1,
			stdout,
			stderr,
			...(terminal.reason === "aborted" ? { aborted: true } : {}),
			...(terminal.reason === "timeout" ? { timedOut: true } : {}),
			...(outputLimitExceeded ? { outputLimitExceeded: true } : {}),
		};
	} catch {
		return { exitCode: 1, stdout: "", stderr: "" };
	} finally {
		detachAbort();
		stdout = "";
		stderr = "";
	}
}

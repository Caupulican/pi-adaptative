/**
 * The one admission of a read-only grant's shell: each command of a `readOnly` lane or session is judged by the
 * read/write line (`readOnlyShellViolation`) against that holder's network grant, scratch directory and private paths.
 * A worker lane applies it in its tool admission, a session in the tool it runs (`wrapToolWithReadOnlyShell`), so the
 * same command gets the same verdict and the same refusal wording wherever it runs, in every execution mode.
 */

import { type ReadOnlyShellLaneScope, readOnlyShellViolation } from "../model-router/read-only-shell-policy.ts";
import type { CredentialExposureBoundary } from "../secrets/credential-exposure-guard.ts";
import { READ_ONLY_SHELL_TOOL_NAMES } from "../tool-capability-policy.ts";
import { wrapToolExecution } from "../tools/tool-execution-wrapper.ts";
import type { EnvelopeScopedTool } from "./envelope-enforcement.ts";
import { laneReadOnlyShellScope, laneReadRoots } from "./lane-shell-scope.ts";

/** What a refusal calls the read-only holder, and what it tells it to do instead. */
export interface ReadOnlyShellVoice {
	readonly subject: string;
	readonly advice: string;
}

export const WORKER_READ_ONLY_SHELL_VOICE: ReadOnlyShellVoice = {
	subject: "worker",
	advice:
		"Read, search and inspect freely; write scratch output only under $TMPDIR (this worker's own scratch directory, removed when it ends); report any change, network access or private file that is needed to the parent instead of reaching it.",
};

const SESSION_READ_ONLY_SHELL_VOICE: ReadOnlyShellVoice = {
	subject: "bot",
	advice:
		"Read, search and inspect freely; this bot creates no file and reaches no network. Report any change, network access or private file that is needed to the owner instead of reaching it.",
};

/**
 * The shell scope of a session that holds a read-only grant, built as a lane's is (`laneReadOnlyShellScope`): no network,
 * no scratch directory (it creates no file), and the session's private harness roots out of reach; a session with a read
 * scope (`readRoots`) reads nothing outside it.
 */
export function sessionReadOnlyShellScope(
	cwd: string,
	deniedPaths: readonly string[],
	boundary: CredentialExposureBoundary,
	readRoots: readonly string[] | undefined,
): ReadOnlyShellLaneScope {
	const facts = { cwd, shellReadOnly: true, readOnly: true, network: false, deniedPaths };
	return laneReadOnlyShellScope(facts, [], boundary, laneReadRoots(readRoots));
}

/** Why a shell tool call is refused for a read-only holder; undefined when the tool is not a shell or the command only reads. */
export function readOnlyShellRefusal(
	lane: ReadOnlyShellLaneScope,
	toolName: string,
	args: unknown,
	cwd: string,
	voice: ReadOnlyShellVoice,
): string | undefined {
	const name = toolName.toLowerCase();
	if (!READ_ONLY_SHELL_TOOL_NAMES.has(name)) return undefined;
	const command = (args as { command?: unknown } | undefined)?.command;
	if (typeof command !== "string") return undefined;
	const violation = readOnlyShellViolation(command, cwd, {
		lane,
		dialect: name === "powershell" ? "powershell" : "posix",
	});
	return violation ? `Read-only ${voice.subject}: ${violation}. ${voice.advice}` : undefined;
}

/** Wrap a session's tool so a shell command that is not read-only is refused when the tool runs; any other tool passes through. */
export function wrapToolWithReadOnlyShell<T extends EnvelopeScopedTool>(
	tool: T,
	lane: ReadOnlyShellLaneScope,
	cwd: string,
): T {
	if (!READ_ONLY_SHELL_TOOL_NAMES.has(tool.name.toLowerCase())) return tool;
	return wrapToolExecution(tool, (executor, executionContext) => {
		type Execute = T["execute"];
		const execute = (...args: Parameters<Execute>): ReturnType<Execute> => {
			const reason = readOnlyShellRefusal(
				lane,
				tool.name,
				args[1],
				executionContext?.cwd ?? cwd,
				SESSION_READ_ONLY_SHELL_VOICE,
			);
			if (reason === undefined) return executor.execute(...args) as ReturnType<Execute>;
			return Promise.resolve({
				content: [{ type: "text", text: `${reason} The tool was NOT run.` }],
				details: { outcome: "read_only_shell_refused", tool: tool.name },
				isError: true,
			}) as ReturnType<Execute>;
		};
		return { ...executor, execute } as T;
	});
}

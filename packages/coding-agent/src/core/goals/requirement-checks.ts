/**
 * Requirement checks: the harness proves a checkable requirement by rerunning its observational
 * command at completion, instead of trusting the agent's account of it.
 *
 * A check must pass the read-only shell line (readOnlyShellViolation): it observes the machine,
 * the repository or a service and never changes them, which is what makes running it from the
 * completion path safe without any further prompt. A run of the project's own tests is admitted
 * too: it is how a check proves code works, and it runs nothing the agent could not already run. Output capture is bounded; a timeout kills the
 * process tree the check started (by handle, never by pid).
 */
import type { ChildProcess } from "node:child_process";
import { type KillTreeOutcome, killTree } from "@caupulican/pi-agent-core/process-tree";
import { spawnProcess } from "../../utils/child-process.ts";
import { getShellConfig } from "../../utils/shell.ts";
import { withoutHarnessLaunchEnv } from "../harness-environment.ts";
import { readOnlyShellViolation } from "../model-router/tool-escalation.ts";
import type { RequirementCheck } from "./goal-state.ts";

export const REQUIREMENT_CHECK_TIMEOUT_MS = 30_000;
const MAX_CHECK_OUTPUT_CHARS = 4_000;

export interface RequirementCheckResult {
	passed: boolean;
	/** Null when the check did not run to an exit (timeout, spawn failure, abort). */
	exitCode: number | null;
	/** Bounded tail of stdout and stderr, in arrival order. */
	output: string;
	/** One complete sentence saying why the requirement holds or not. */
	reason: string;
}

/** Why `check` cannot be a requirement check, or undefined when it can. */
export function requirementCheckViolation(check: RequirementCheck, cwd: string): string | undefined {
	if (!check.command.trim()) return "A check needs a command.";
	const violation = readOnlyShellViolation(check.command, cwd, { admitTestRuns: true });
	return violation
		? `A check may only observe, but \`${check.command}\` ${violation.replace(/^it /u, "")}.`
		: undefined;
}

/** Decide a finished run against the check's expectations. Pure. */
export function judgeRequirementCheck(
	check: RequirementCheck,
	exitCode: number,
	output: string,
): Pick<RequirementCheckResult, "passed" | "reason"> {
	const expected = check.expectExitCode ?? 0;
	if (exitCode !== expected) {
		return { passed: false, reason: `\`${check.command}\` exited ${exitCode}, expected ${expected}.` };
	}
	if (check.outputContains !== undefined && !output.includes(check.outputContains)) {
		return { passed: false, reason: `\`${check.command}\` output does not contain "${check.outputContains}".` };
	}
	if (check.outputExcludes !== undefined && output.includes(check.outputExcludes)) {
		return { passed: false, reason: `\`${check.command}\` output still contains "${check.outputExcludes}".` };
	}
	return { passed: true, reason: `\`${check.command}\` exited ${exitCode} as expected.` };
}

/** Run one check in `cwd`. A check that cannot run is a failed check, never a pass. */
export function runRequirementCheck(
	check: RequirementCheck,
	options: {
		cwd: string;
		timeoutMs?: number;
		signal?: AbortSignal;
		terminateTree?: (child: ChildProcess) => Promise<KillTreeOutcome>;
	},
): Promise<RequirementCheckResult> {
	const violation = requirementCheckViolation(check, options.cwd);
	if (violation) return Promise.resolve({ passed: false, exitCode: null, output: "", reason: violation });
	let child: ChildProcess;
	try {
		const shell = getShellConfig(undefined, "bash");
		child = spawnProcess(shell.shell, [...shell.args, check.command], {
			cwd: options.cwd,
			env: withoutHarnessLaunchEnv({ ...process.env }),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return Promise.resolve({
			passed: false,
			exitCode: null,
			output: "",
			reason: `The check could not start: ${message}.`,
		});
	}
	return new Promise((resolve) => {
		let output = "";
		let settled = false;
		let stopping = false;
		const append = (chunk: Buffer) => {
			output = (output + chunk.toString("utf8")).slice(-MAX_CHECK_OUTPUT_CHARS);
		};
		const finish = (result: RequirementCheckResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const stop = async (reason: string): Promise<void> => {
			if (settled || stopping) return;
			stopping = true;
			try {
				const outcome = await (options.terminateTree ?? killTree)(child);
				finish({
					passed: false,
					exitCode: null,
					output,
					reason: outcome === "failed" ? `${reason} The process-tree termination is unproven.` : reason,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				finish({
					passed: false,
					exitCode: null,
					output,
					reason: `${reason} Process-tree termination failed (${message}); termination is unproven.`,
				});
			}
		};
		const timeoutMs = options.timeoutMs ?? REQUIREMENT_CHECK_TIMEOUT_MS;
		const timer = setTimeout(() => {
			void stop(`\`${check.command}\` did not finish within ${timeoutMs} ms.`);
		}, timeoutMs);
		const onAbort = () => {
			void stop("The check was cancelled.");
		};
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.on("error", (error) => {
			if (!stopping)
				finish({ passed: false, exitCode: null, output, reason: `The check failed to run: ${error.message}.` });
		});
		child.on("close", (code) => {
			if (stopping) return;
			if (code === null)
				return finish({ passed: false, exitCode: null, output, reason: "The check was terminated." });
			finish({ exitCode: code, output, ...judgeRequirementCheck(check, code, output) });
		});
	});
}

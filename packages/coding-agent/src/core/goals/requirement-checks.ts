/**
 * Requirement checks: the harness proves a checkable requirement by rerunning its observational
 * command at completion, instead of trusting the agent's account of it.
 *
 * A check must pass the read-only shell line (readOnlyShellViolation): it observes the machine,
 * the repository or a service and never changes them, which is what makes running it from the
 * completion path safe without any further prompt. A run of the project's own tests is admitted
 * too: it is how a check proves code works, and it runs nothing the agent could not already run. Output capture is bounded; a timeout kills the
 * process tree the check started (by handle, never by pid). The caller names the admission and the environment of whoever the
 * check runs for: a session's goal check runs through `session-requirement-check.ts`, as the session's own commands run.
 */
import type { ChildProcess } from "node:child_process";
import { type KillTreeOutcome, killTree } from "../../kernel/reliability/process-tree.ts";
import { spawnProcess } from "../../utils/child-process.ts";
import { getShellConfig } from "../../utils/shell.ts";
import { readOnlyShellViolation } from "../model-router/read-only-shell-policy.ts";
import type { Requirement, RequirementCheck } from "./goal-state.ts";

export const REQUIREMENT_CHECK_TIMEOUT_MS = 30_000;
const MAX_CHECK_OUTPUT_CHARS = 4_000;

/** Exact acceptance wording that can be verified against a complete owner statement without semantic inference. */
export function isExplicitRequirementCheckContract(requirement: Requirement): boolean {
	const check = requirement.check;
	if (!check) return false;
	const clauses = [`Run ${JSON.stringify(check.command)} and require exit code ${check.expectExitCode ?? 0}.`];
	if (check.outputContains !== undefined) clauses.push(`Output must contain ${JSON.stringify(check.outputContains)}.`);
	if (check.outputExcludes !== undefined) clauses.push(`Output must exclude ${JSON.stringify(check.outputExcludes)}.`);
	return requirement.text.trim() === clauses.join(" ");
}

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
function decideCheck(
	check: RequirementCheck,
	exitCode: number,
	contains: (expected: string) => boolean,
): Pick<RequirementCheckResult, "passed" | "reason"> {
	const expected = check.expectExitCode ?? 0;
	if (exitCode !== expected) {
		return { passed: false, reason: `\`${check.command}\` exited ${exitCode}, expected ${expected}.` };
	}
	if (check.outputContains !== undefined && !contains(check.outputContains)) {
		return { passed: false, reason: `\`${check.command}\` output does not contain "${check.outputContains}".` };
	}
	if (check.outputExcludes !== undefined && contains(check.outputExcludes)) {
		return { passed: false, reason: `\`${check.command}\` output still contains "${check.outputExcludes}".` };
	}
	return { passed: true, reason: `\`${check.command}\` exited ${exitCode} as expected.` };
}

export function judgeRequirementCheck(
	check: RequirementCheck,
	exitCode: number,
	output: string,
): Pick<RequirementCheckResult, "passed" | "reason"> {
	return decideCheck(check, exitCode, (text) => output.includes(text));
}

/** Match expectations against the whole run while retaining only a bounded diagnostic tail. */
export class RequirementCheckOutput {
	tail = "";
	private overlap = "";
	private readonly missing: Set<string>;
	private readonly found = new Set<string>();

	private readonly check: RequirementCheck;

	constructor(check: RequirementCheck) {
		this.check = check;
		this.missing = new Set(
			[check.outputContains, check.outputExcludes].filter(
				(text): text is string => text !== undefined && text !== "",
			),
		);
	}

	append(chunk: string): void {
		this.tail = (this.tail + chunk).slice(-MAX_CHECK_OUTPUT_CHARS);
		if (this.missing.size === 0) return;
		const window = this.overlap + chunk;
		let overlapLength = 0;
		for (const needle of this.missing) {
			if (window.includes(needle)) {
				this.found.add(needle);
				this.missing.delete(needle);
			} else overlapLength = Math.max(overlapLength, needle.length - 1);
		}
		this.overlap = overlapLength ? window.slice(-overlapLength) : "";
	}

	judge(exitCode: number): Pick<RequirementCheckResult, "passed" | "reason"> {
		return decideCheck(this.check, exitCode, (needle) => needle === "" || this.found.has(needle));
	}
}

/** Run one check in `cwd`. A check that cannot run is a failed check, never a pass. */
export function runRequirementCheck(
	check: RequirementCheck,
	options: {
		cwd: string;
		timeoutMs?: number;
		signal?: AbortSignal;
		terminateTree?: (child: ChildProcess) => Promise<KillTreeOutcome>;
		/**
		 * Why the command may not run, judged before it runs: the admission of whoever the check runs for, at least the
		 * requirement line (`requirementCheckViolation`) unless the caller admitted the command itself.
		 */
		admit: (check: RequirementCheck) => string | undefined;
		/** The environment the command runs with: that of whoever the check runs for (a session's: its shell commands'). */
		env: NodeJS.ProcessEnv;
	},
): Promise<RequirementCheckResult> {
	if (options.signal?.aborted)
		return Promise.resolve({ passed: false, exitCode: null, output: "", reason: "The check was cancelled." });
	const violation = options.admit(check);
	if (violation) return Promise.resolve({ passed: false, exitCode: null, output: "", reason: violation });
	let child: ChildProcess;
	try {
		const shell = getShellConfig(undefined, "bash");
		child = spawnProcess(shell.shell, [...shell.args, check.command], {
			cwd: options.cwd,
			env: options.env,
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
		const output = new RequirementCheckOutput(check);
		let settled = false;
		let stopping = false;
		const append = (chunk: string) => output.append(chunk);
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
					output: output.tail,
					reason: outcome === "failed" ? `${reason} The process-tree termination is unproven.` : reason,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				finish({
					passed: false,
					exitCode: null,
					output: output.tail,
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
		child.stdout?.setEncoding("utf8").on("data", append);
		child.stderr?.setEncoding("utf8").on("data", append);
		child.on("error", (error) => {
			if (!stopping)
				finish({
					passed: false,
					exitCode: null,
					output: output.tail,
					reason: `The check failed to run: ${error.message}.`,
				});
		});
		child.on("close", (code) => {
			if (stopping) return;
			if (code === null)
				return finish({ passed: false, exitCode: null, output: output.tail, reason: "The check was terminated." });
			finish({ exitCode: code, output: output.tail, ...output.judge(code) });
		});
	});
}

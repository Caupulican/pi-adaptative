/**
 * A requirement check run for a session's own goal: the check is a command the harness runs on the session's behalf, so it
 * is admitted, run and masked as the session's own shell commands are, never wider. It must pass the requirement line (it
 * only observes, a test run included) and, in a session confined to a read-only shell (a read-only bot's), that line too.
 * The session's credential guard meets it as it meets the shell's command: a session whose commands keep owner credentials
 * out (`deny`) refuses a check that reaches one, and any other runs it and masks the output it keeps (the goal's evidence)
 * with the mask its shell's output gets. The check runs in the environment the session's shell spawns its commands with
 * (`SessionCommandEnvironment.spawnEnvironment`: the session's identity variables, its spawn hook's environment). The same
 * admission holds when a check is attached.
 */

import type { SessionConfinement } from "../autonomy/session-confinement.ts";
import { readOnlyShellViolation } from "../model-router/read-only-shell-policy.ts";
import { assessCommandOutputExposure } from "../secrets/command-output-exposure.ts";
import { type CredentialExposureBoundary, credentialToolBlockReason } from "../secrets/credential-exposure-guard.ts";
import type { RequirementCheck } from "./goal-state.ts";
import { type RequirementCheckResult, requirementCheckViolation, runRequirementCheck } from "./requirement-checks.ts";

/** What a session holds that admits and runs its own commands: its confinement and its credential boundary. */
export interface RequirementCheckSession {
	readonly sessionConfinement: SessionConfinement;
	readonly credentialExposureBoundary: CredentialExposureBoundary;
}

/**
 * The host's own checks of its goal's requirements, run for one worker attempt in the directory the attempt ran in, and the
 * proof a passing one records.
 */
export interface HostRequirementChecks {
	/** Run one check in `cwd`, admitted, run and masked as the goal's session runs its own commands. */
	run(check: RequirementCheck, cwd: string, signal: AbortSignal): Promise<RequirementCheckResult>;
	/**
	 * A check that passed: record it as that requirement's proof (`recordHostRequirementCheckProof`), exactly once per attempt
	 * and requirement. Present on the host that owns the goal state; a host without it records the pass on the outcome alone.
	 */
	recordProof?(attemptId: string, requirementId: string, result: RequirementCheckResult): void;
}

/** Why the session may not run `check` in `cwd`, as a sentence, or undefined when it may: judged when it is attached and run. */
export function sessionRequirementCheckViolation(
	check: RequirementCheck,
	session: RequirementCheckSession,
	cwd: string,
): string | undefined {
	const requirement = requirementCheckViolation(check, cwd);
	if (requirement) return requirement;
	const confinement = session.sessionConfinement;
	const credential =
		confinement.credentialExposure === "deny"
			? credentialToolBlockReason("bash", { command: check.command }, cwd, session.credentialExposureBoundary)
			: undefined;
	if (credential) return credential;
	const lane = confinement.readOnlyShell;
	const violation = lane && readOnlyShellViolation(check.command, cwd, { lane, dialect: "posix" });
	return violation
		? `This session has a read-only shell: \`${check.command}\` ${violation.replace(/^it /u, "")}.`
		: undefined;
}

/**
 * Run one of the session's requirement checks in `cwd`: admitted, run and its kept output masked as its shell commands are.
 * A check that cannot be prepared (its admission, credential assessment, environment or mask) is a failed check, so a caller
 * that does not await the result (the host check after a worker attempt) never meets a rejection.
 */
export async function runSessionRequirementCheck(
	check: RequirementCheck,
	session: RequirementCheckSession,
	cwd: string,
	signal?: AbortSignal,
): Promise<RequirementCheckResult> {
	const confinement = session.sessionConfinement;
	let refusal: string | undefined;
	let env: NodeJS.ProcessEnv;
	let mask: (output: string) => string;
	try {
		const exposure = await assessCommandOutputExposure(
			check.command,
			cwd,
			session.credentialExposureBoundary,
			confinement.credentialExposure,
			signal,
		);
		refusal = sessionRequirementCheckViolation(check, session, cwd) ?? exposure.refusal;
		env = confinement.shellEnvironment(cwd);
		mask = exposure.mask;
	} catch (error) {
		return {
			passed: false,
			exitCode: null,
			output: "",
			// A cancel during preparation is the run's cancel, told as runRequirementCheck tells it.
			reason: signal?.aborted ? "The check was cancelled." : `The check could not be prepared: ${messageOf(error)}.`,
		};
	}
	const result = await runRequirementCheck(check, { cwd, ...(signal ? { signal } : {}), admit: () => refusal, env });
	try {
		// The kept output is the tail of the run's output, so the mask meets it as a fragment of it.
		return { ...result, output: mask(result.output) };
	} catch (error) {
		// Output that cannot be masked is not kept.
		return {
			...result,
			output: "",
			reason: `${result.reason} Its output could not be masked (${messageOf(error)}), so none is kept.`,
		};
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

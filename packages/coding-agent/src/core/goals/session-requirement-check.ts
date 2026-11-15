/**
 * A requirement check run for a session's own goal: the check is a command the harness runs on the session's behalf, so it
 * is admitted, run and masked as the session's own shell commands are, never wider. It must pass the requirement line (it
 * only observes, a test run included) and, in a session confined to a read-only shell (a read-only bot's), that line too.
 * The session's credential guard meets it as it meets the shell's command: a session whose commands keep owner credentials
 * out (`deny`) refuses a check that reaches one, and any other runs it and masks the output it keeps (the goal's evidence,
 * the results the goal tool shows) with the mask its shell's output gets. The check runs in the environment the session's
 * shell commands get (`SessionCommandEnvironment.shellEnvironment`).
 */

import { getShellEnv } from "../../utils/shell.ts";
import type { SessionConfinement } from "../autonomy/session-confinement.ts";
import { readOnlyShellViolation } from "../model-router/read-only-shell-policy.ts";
import {
	assessCredentialCall,
	type CredentialCallExposure,
	type CredentialExposureBoundary,
	createOutputRedactor,
	credentialToolBlockReason,
} from "../secrets/credential-exposure-guard.ts";
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

/** Why the session may not run `check` in `cwd`, as a sentence, or undefined when it may. */
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

/** Run one of the session's requirement checks in `cwd`: admitted, run and its kept output masked as its shell commands are. */
export async function runSessionRequirementCheck(
	check: RequirementCheck,
	session: RequirementCheckSession,
	cwd: string,
	signal?: AbortSignal,
): Promise<RequirementCheckResult> {
	const boundary = session.credentialExposureBoundary;
	const confinement = session.sessionConfinement;
	let sensitiveValues: readonly string[];
	let exposure: CredentialCallExposure;
	try {
		sensitiveValues = (await boundary.getSensitiveValues?.()) ?? [];
		// The check's own run is cancelled by `signal`; the assessment is not, so a cancelled check ends as a failed check.
		exposure = await assessCredentialCall(
			"bash",
			{ command: check.command },
			cwd,
			boundary,
			confinement.credentialExposure,
			{ harnessTool: false },
		);
	} catch (error) {
		// A check the guard could not assess is not run: it is a failed check, as one that cannot start is.
		const message = error instanceof Error ? error.message : String(error);
		return {
			passed: false,
			exitCode: null,
			output: "",
			reason: `The check's credential assessment failed: ${message}.`,
		};
	}
	const result = await runRequirementCheck(check, {
		cwd,
		...(signal ? { signal } : {}),
		admit: (candidate) => sessionRequirementCheckViolation(candidate, session, cwd) ?? exposure.refusal,
		env: confinement.shellEnvironment(getShellEnv(), cwd),
	});
	// The kept output is the tail of the run's output, so it is masked as a fragment of it.
	return { ...result, output: createOutputRedactor(boundary, exposure.mock.fragment, sensitiveValues)(result.output) };
}

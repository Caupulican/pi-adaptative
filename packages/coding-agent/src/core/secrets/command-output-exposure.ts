/**
 * How a command the harness runs on a session's behalf (a goal's requirement check, a watched command) meets the session's
 * credential guard, as the session's shell tool meets the same command (`assessCredentialCall`): in `deny` mode the
 * refusal of a command that reaches an owner credential, and in any mode the mask the output it keeps gets, the shell's
 * output mask (known credential values, then the call's exposure mock), applied as to a fragment since what is kept is a
 * tail or an excerpt of the output. Every such command is met here, so none keeps output masked less than the shell's.
 */

import {
	assessCredentialCall,
	type CredentialExposureBoundary,
	type CredentialExposureMode,
	createOutputRedactor,
} from "./credential-exposure-guard.ts";

export interface CommandOutputExposure {
	/** Why the session's shell would refuse the command (`deny` mode, an owner credential reached), or undefined. */
	readonly refusal: string | undefined;
	/** The mask the output the command keeps gets. */
	readonly mask: (output: string) => string;
}

/** Assess `command` in `cwd` as the session's shell would before running it; rejects when the guard cannot assess it. */
export async function assessCommandOutputExposure(
	command: string,
	cwd: string,
	boundary: CredentialExposureBoundary | undefined,
	mode: CredentialExposureMode,
	signal: AbortSignal | undefined,
): Promise<CommandOutputExposure> {
	const sensitiveValues = (await boundary?.getSensitiveValues?.()) ?? [];
	const exposure = await assessCredentialCall("bash", { command }, cwd, boundary, mode, {
		signal,
		harnessTool: false,
	});
	return { refusal: exposure.refusal, mask: createOutputRedactor(boundary, exposure.mock.fragment, sensitiveValues) };
}

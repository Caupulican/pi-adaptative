/**
 * What confines a session's own tools beyond its path envelopes, built from the private path scope it was created with:
 * the read-only line its shell is held to (`readOnlyShell`) and the roots it reads in (`readRoots`). Its tools are wrapped
 * with both when they run, and its watches are judged by both at arming and at every run; a watched command also runs in
 * an environment closed as the session's own commands are (`commandEnvironment`, from its `SessionCommandEnvironment`).
 * How its commands meet an owner credential (`credentialExposure`) and the environment they run in (`shellEnvironment`)
 * are kept too: a requirement check the harness runs for the session is admitted, masked and run by them. The
 * roots it writes in and the paths denied to it, as its path envelopes computed them, are kept beside them: with the
 * shell's line and the read roots they are the ceiling it holds over its workers (`worker-parent-ceiling.ts`).
 */

import type { ReadOnlyShellLaneScope } from "../model-router/read-only-shell-policy.ts";
import type { CredentialExposureBoundary, CredentialExposureMode } from "../secrets/credential-exposure-guard.ts";
import type { EnvelopeScopedTool } from "./envelope-enforcement.ts";
import { sessionReadOnlyShellScope, wrapToolWithReadOnlyShell } from "./read-only-shell-admission.ts";
import { wrapToolWithReadScope } from "./read-scope-admission.ts";
import type { SessionCommandEnvironment } from "./session-command-environment.ts";
import type { SessionPathEnvelopes } from "./session-path-envelopes.ts";
import type { SessionReadScope } from "./session-read-scope.ts";
import type { SessionPrivatePathScope } from "./worker-session-private-scope.ts";

export interface SessionConfinement {
	readonly readOnlyShell?: ReadOnlyShellLaneScope;
	readonly readScope?: SessionReadScope;
	/** The roots its writes stay in (`SessionPathEnvelopes.writeRoots`); unset writes host-wide. */
	readonly writeRoots?: readonly string[];
	/** The paths denied to its reads and writes: the private harness roots and its scope's own. */
	readonly deniedPaths: readonly string[];
	/**
	 * A watched command's environment over the watch's bounded `base`, closed as the session's own commands are (role, run
	 * marker, scratch, offline and read-only variables); absent where they carry none, so a watch's environment stays its
	 * bounded base. A command of the session's own (a requirement check) runs in `shellEnvironment` instead.
	 */
	readonly commandEnvironment?: (base: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
	/** How its commands meet an owner credential: `deny` refuses one that reaches it, `mock` runs it and masks its output. */
	readonly credentialExposure: CredentialExposureMode;
	/** The environment one of its own commands in `cwd` runs in, its identity variables included, as its shell spawns one. */
	readonly shellEnvironment: (cwd: string) => NodeJS.ProcessEnv;
}

/** What the session holds that its confinement reads: its credential boundary and its own commands' environment. */
export interface SessionConfinementSources {
	readonly boundary: CredentialExposureBoundary;
	readonly commands: Pick<
		SessionCommandEnvironment,
		"watchedCommandEnvironment" | "credentialExposure" | "spawnEnvironment"
	>;
}

export function buildSessionConfinement(
	cwd: string,
	scope: SessionPrivatePathScope | undefined,
	envelopes: SessionPathEnvelopes,
	{ boundary, commands }: SessionConfinementSources,
): SessionConfinement {
	const readScope = envelopes.readScope;
	const deniedPaths = envelopes.privatePaths?.deniedPaths ?? [];
	return {
		...(scope?.readOnlyShell
			? {
					readOnlyShell: sessionReadOnlyShellScope(
						cwd,
						deniedPaths,
						boundary,
						readScope?.readRoots,
						scope.network === true,
					),
				}
			: {}),
		...(readScope ? { readScope } : {}),
		...(envelopes.writeRoots ? { writeRoots: envelopes.writeRoots } : {}),
		deniedPaths,
		credentialExposure: commands.credentialExposure,
		shellEnvironment: (cwd) => commands.spawnEnvironment(cwd),
		...(commands.watchedCommandEnvironment ? { commandEnvironment: commands.watchedCommandEnvironment } : {}),
	};
}

/** Wrap a session's tool so it runs inside the session's confinement; an unconfined session's tool is returned as is. */
export function wrapToolWithSessionConfinement<T extends EnvelopeScopedTool>(
	tool: T,
	confinement: SessionConfinement,
	cwd: string,
): T {
	const shelled = confinement.readOnlyShell ? wrapToolWithReadOnlyShell(tool, confinement.readOnlyShell, cwd) : tool;
	return confinement.readScope ? wrapToolWithReadScope(shelled, confinement.readScope) : shelled;
}

/**
 * What confines a session's own tools beyond its path envelopes, built from the private path scope it was created with:
 * the read-only line its shell is held to (`readOnlyShell`) and the roots it reads in (`readRoots`). Its tools are wrapped
 * with both when they run, and its watches are judged by both at arming and at every run; a watched command also runs in
 * the environment the session's own commands run in (`commandEnvironment`, from its `SessionCommandEnvironment`). The
 * roots it writes in and the paths denied to it, as its path envelopes computed them, are kept beside them: with the
 * shell's line and the read roots they are the ceiling it holds over its workers (`worker-parent-ceiling.ts`).
 */

import type { ReadOnlyShellLaneScope } from "../model-router/read-only-shell-policy.ts";
import type { CredentialExposureBoundary } from "../secrets/credential-exposure-guard.ts";
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
	/** A watched command's environment over the watch's bounded `base`, closed as the session's own commands are. */
	readonly commandEnvironment?: (base: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
}

/** What the session holds that its confinement reads: its credential boundary and its own commands' environment. */
export interface SessionConfinementSources {
	readonly boundary: CredentialExposureBoundary;
	readonly commands: Pick<SessionCommandEnvironment, "watchedCommandEnvironment">;
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

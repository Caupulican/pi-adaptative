/**
 * What confines a session's own tools beyond its path envelopes, built from the private path scope it was created with:
 * the read-only line its shell is held to (`readOnlyShell`) and the roots it reads in (`readRoots`). Its tools are wrapped
 * with both when they run, and its watches are judged by both at arming and at every run.
 */

import type { ReadOnlyShellLaneScope } from "../model-router/read-only-shell-policy.ts";
import type { CredentialExposureBoundary } from "../secrets/credential-exposure-guard.ts";
import type { EnvelopeScopedTool } from "./envelope-enforcement.ts";
import { sessionReadOnlyShellScope, wrapToolWithReadOnlyShell } from "./read-only-shell-admission.ts";
import { wrapToolWithReadScope } from "./read-scope-admission.ts";
import type { SessionPathEnvelopes } from "./session-path-envelopes.ts";
import type { SessionReadScope } from "./session-read-scope.ts";
import type { SessionPrivatePathScope } from "./worker-session-private-scope.ts";

export interface SessionConfinement {
	readonly readOnlyShell?: ReadOnlyShellLaneScope;
	readonly readScope?: SessionReadScope;
}

export function buildSessionConfinement(
	cwd: string,
	scope: SessionPrivatePathScope | undefined,
	envelopes: SessionPathEnvelopes,
	boundary: CredentialExposureBoundary,
): SessionConfinement {
	const readScope = envelopes.readScope;
	const deniedPaths = envelopes.privatePaths?.deniedPaths ?? [];
	return {
		...(scope?.readOnlyShell
			? { readOnlyShell: sessionReadOnlyShellScope(cwd, deniedPaths, boundary, readScope?.readRoots) }
			: {}),
		...(readScope ? { readScope } : {}),
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

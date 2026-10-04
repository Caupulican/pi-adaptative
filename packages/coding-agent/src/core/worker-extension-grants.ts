/**
 * Extension-tool grants for a worker PROCESS. A worker imports only passive bundled extensions and holds
 * only the allow-listed tool surface (`worker-tool-ceiling.ts`); the one way to add an extension-provided
 * tool is an explicit launch-profile grant naming the tool and the extension file that provides it. The
 * launcher writes the grant into the child's environment; the child then loads exactly that extension
 * TOOL-ONLY (`extensions/tool-only-api.ts`: its factory runs, but only the granted tool registers and every
 * other registration or session action is a recorded no-op) and admits exactly that tool name. The tool's
 * `execute` receives a restricted context (`extensions/tool-only-api.ts`), runs under the worker's
 * credential-exposure guard and task directory binding, and is classified at startup
 * (`registerWorkerExtensionToolPolicies`) so the worker's path envelopes check its path-looking arguments.
 * Authority-bearing builtin tools can never be named here (`isExtensionToolGrantable`).
 */

import * as path from "node:path";
import { registerGrantedExtensionToolPolicies } from "./tool-capability-policy.ts";
import { isExtensionToolGrantable } from "./worker-tool-ceiling.ts";

export const PI_WORKER_EXTENSION_TOOLS_ENV = "PI_WORKER_EXTENSION_TOOLS";

export const MAX_WORKER_EXTENSION_TOOL_GRANTS = 32;

export interface WorkerExtensionToolGrant {
	readonly tool: string;
	readonly extensionPath: string;
}

const MALFORMED = `${PI_WORKER_EXTENSION_TOOLS_ENV} must be a JSON array of { tool, extensionPath } grants with absolute extension paths and grantable extension tool names.`;

/** Strictly decode a grant list. A malformed list throws: a launch defect is reported, never read as "no grant". */
export function parseWorkerExtensionToolGrants(raw: string | undefined): readonly WorkerExtensionToolGrant[] {
	if (raw === undefined) return Object.freeze([]);
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(MALFORMED);
	}
	if (!Array.isArray(parsed) || parsed.length > MAX_WORKER_EXTENSION_TOOL_GRANTS) throw new Error(MALFORMED);
	const seen = new Set<string>();
	const grants: WorkerExtensionToolGrant[] = [];
	for (const entry of parsed) {
		if (typeof entry !== "object" || entry === null) throw new Error(MALFORMED);
		const { tool, extensionPath } = entry as { tool?: unknown; extensionPath?: unknown };
		if (
			typeof tool !== "string" ||
			typeof extensionPath !== "string" ||
			!isExtensionToolGrantable(tool) ||
			!(path.isAbsolute(extensionPath) || path.win32.isAbsolute(extensionPath))
		) {
			throw new Error(MALFORMED);
		}
		if (seen.has(tool)) continue;
		seen.add(tool);
		grants.push(Object.freeze({ tool, extensionPath }));
	}
	return Object.freeze(grants);
}

export function encodeWorkerExtensionToolGrants(grants: readonly WorkerExtensionToolGrant[]): string {
	return JSON.stringify(parseWorkerExtensionToolGrants(JSON.stringify(grants)));
}

export function readWorkerExtensionToolGrants(
	env: NodeJS.ProcessEnv = process.env,
): readonly WorkerExtensionToolGrant[] {
	return parseWorkerExtensionToolGrants(env[PI_WORKER_EXTENSION_TOOLS_ENV]);
}

/**
 * Classify the granted extension tools in the tool capability policy (worker process only; the grant loader's
 * half of the path-envelope boundary). Throws on a name the catalogue already classifies: the worker does not
 * start with a grant that would carry builtin authority.
 */
export function registerWorkerExtensionToolPolicies(grants: readonly WorkerExtensionToolGrant[]): void {
	registerGrantedExtensionToolPolicies(grants.map((grant) => grant.tool));
}

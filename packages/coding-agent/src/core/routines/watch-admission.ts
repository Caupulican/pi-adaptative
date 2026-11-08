/**
 * What a session may watch. The same rules admit a watch when it is saved and apply again at every evaluation, so a
 * condition saved earlier is never evaluated with more authority than the session has now:
 * - a file is read through the session's own read scope (its allowed roots, the harness's private paths, the
 *   credential policy), never a directory or a glob;
 * - a command passes the line of a read-only worker's shell (no writes, no network, no private paths) and runs with a
 *   bounded environment, never with more authority than that;
 * - a managed process is a process-matrix entry that has not ended yet.
 * Ports, pages and the cadence are bounded by the condition's own schema; a page's address is checked again at fetch.
 */

import { type Stats, statSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import type { CapabilityEnvelope } from "../autonomy/contracts.ts";
import { projectLaneSettingsPath } from "../autonomy/lane-private-paths.ts";
import {
	privatePathBoundary,
	readScopeRefusal,
	type SessionReadScope,
	sessionReadScope,
} from "../autonomy/session-read-scope.ts";
import { type ReadOnlyShellLaneScope, readOnlyShellViolation } from "../model-router/read-only-shell-policy.ts";
import { readEntrySync } from "../process-matrix/store.ts";
import { type CredentialExposureBoundary, isProtectedCredentialPath } from "../secrets/credential-exposure-guard.ts";
import { assertPublicAddress } from "../web/public-web-client.ts";
import type { WatchCondition } from "./watch-contract.ts";

export interface WatchAdmissionHost {
	getCwd(): string;
	getAgentDir(): string;
	getCapabilityEnvelope(): CapabilityEnvelope | undefined;
	getCredentialExposureBoundary?(): CredentialExposureBoundary | undefined;
}

const GLOB_CHARACTERS = /[*?[\]{}]/u;

function statOrUndefined(path: string): Stats | undefined {
	try {
		return statSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export class WatchAdmission {
	private readonly host: WatchAdmissionHost;

	constructor(host: WatchAdmissionHost) {
		this.host = host;
	}

	cwd(): string {
		return this.host.getCwd();
	}

	private scope(): SessionReadScope {
		return sessionReadScope({
			cwd: this.host.getCwd(),
			agentDir: this.host.getAgentDir(),
			envelope: this.host.getCapabilityEnvelope(),
		});
	}

	private boundary(scope: SessionReadScope): CredentialExposureBoundary {
		return this.host.getCredentialExposureBoundary?.() ?? privatePathBoundary(scope.deniedPaths, scope.cwd);
	}

	/**
	 * The condition as the session may watch it now, in canonical form (a file's absolute path), or an error naming the
	 * authority it lacks. This is the part applied at every evaluation: it checks authority only, never whether the
	 * watched thing still exists, so a file that vanished or a process that ended is an observation, not a refusal.
	 */
	authorize(condition: WatchCondition): WatchCondition {
		switch (condition.type) {
			case "file":
				return { ...condition, path: this.authorizeFile(condition.path) };
			case "command": {
				const violation = this.commandViolation(condition.command);
				if (violation)
					throw new Error(`A watched command may only observe, but it ${violation.replace(/^it /u, "")}.`);
				return condition;
			}
			case "process":
			case "port":
			case "http":
				return condition;
		}
	}

	/** {@link authorize} plus what must hold when a watch is saved: the file or process exists and has not ended. */
	admit(condition: WatchCondition): WatchCondition {
		const authorized = this.authorize(condition);
		if (authorized.type === "file") {
			const stats = statOrUndefined(authorized.path);
			if (stats?.isDirectory()) throw new Error("A watched file is one file, not a directory.");
			if (!stats && !statOrUndefined(dirname(authorized.path))?.isDirectory())
				throw new Error("The folder of a watched file must exist.");
		} else if (authorized.type === "http") {
			// A literal address is checked now; a name that resolves to a private address is refused at every fetch.
			const host = new URL(authorized.url).hostname.replace(/^\[|\]$/gu, "");
			if (isIP(host) !== 0)
				try {
					assertPublicAddress(host);
				} catch {
					throw new Error("A watched page must be on a public internet address.");
				}
		} else if (authorized.type === "process") {
			const entry = readEntrySync(this.host.getAgentDir(), authorized.processId);
			if (!entry) throw new Error("No managed process with that id is recorded on this machine.");
			if (entry.terminal !== undefined || entry.status === "closed")
				throw new Error("That managed process has already exited.");
		}
		return authorized;
	}

	private authorizeFile(path: string): string {
		if (GLOB_CHARACTERS.test(path)) throw new Error("A watched file is one file, not a glob.");
		const scope = this.scope();
		const absolute = isAbsolute(path) ? resolve(path) : resolve(scope.cwd, path);
		const refusal = readScopeRefusal(scope, absolute);
		if (refusal === "outside") throw new Error("That file is outside the paths this session may read.");
		if (refusal === "denied" || isProtectedCredentialPath(absolute, scope.cwd, this.boundary(scope)))
			throw new Error("That file is private to the harness or holds credentials, so it cannot be watched.");
		return absolute;
	}

	/** Why a read-only worker's shell would refuse `command`, or undefined when it may run on a watch's cadence. */
	commandViolation(command: string): string | undefined {
		const scope = this.scope();
		const boundary = this.boundary(scope);
		const projectSettings = resolve(projectLaneSettingsPath(scope.cwd));
		const lane: ReadOnlyShellLaneScope = {
			network: false,
			scratchRoots: [],
			homeDir: homedir(),
			cdPath: (process.env.CDPATH ?? "").split(delimiter).filter((entry) => entry.length > 0),
			harnessStoragePaths: scope.deniedPaths.filter((entry) => resolve(entry) !== projectSettings),
			isDeniedPath: (target) =>
				isProtectedCredentialPath(target, scope.cwd, boundary) || readScopeRefusal(scope, target) !== undefined,
		};
		return readOnlyShellViolation(command, scope.cwd, { lane });
	}
}

/** The few variables a watched command inherits: enough to find programs and format text, no credentials. */
export function watchCommandEnvironment(): NodeJS.ProcessEnv {
	const keep = [
		"PATH",
		"HOME",
		"USER",
		"LOGNAME",
		"LANG",
		"LC_ALL",
		"TZ",
		"TERM",
		"SHELL",
		"SYSTEMROOT",
		"COMSPEC",
		"PATHEXT",
	];
	const env: NodeJS.ProcessEnv = {};
	for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
	return env;
}

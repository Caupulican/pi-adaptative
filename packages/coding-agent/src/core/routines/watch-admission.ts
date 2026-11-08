/**
 * What a session may watch. The same rules admit a watch when it is saved and apply again at every evaluation, so a
 * condition saved earlier is never evaluated with more authority than the session has now:
 * - a path (a file, a folder or a glob pattern) is observed through its metadata, which needs no read authority; its
 *   content is digested only where the session's read scope and the credential policy allow reading it;
 * - a command passes the admission the owner's own shell calls pass (the capability envelope, credential protection,
 *   edge classification against the session's edge grants), non-interactively: whatever would ask the owner is
 *   refused, since a watch cannot ask. It runs with a bounded environment;
 * - a managed process is a process-matrix entry that has not ended yet, and an operating-system process must be running.
 * Ports, pages and the cadence are bounded by the condition's own schema; a page's address is checked again at fetch.
 */

import { type Stats, statSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import type { CapabilityEnvelope } from "../autonomy/contracts.ts";
import {
	classifyAllEdgeOperations,
	classifyYoloBoundary,
	type EdgeGrantView,
	isEdgeOperationGranted,
} from "../autonomy/edge-policy.ts";
import { evaluateToolGate } from "../autonomy/gates.ts";
import {
	privatePathBoundary,
	readScopeRefusal,
	type SessionReadScope,
	sessionReadScope,
} from "../autonomy/session-read-scope.ts";
import { readEntrySync } from "../process-matrix/store.ts";
import {
	type CredentialExposureBoundary,
	credentialToolBlockReason,
	isProtectedCredentialPath,
} from "../secrets/credential-exposure-guard.ts";
import { assertReachableAddress } from "../web/public-web-client.ts";
import { isWatchGlob, splitWatchPattern, type WatchCondition } from "./watch-contract.ts";

export interface WatchAdmissionHost {
	getCwd(): string;
	getAgentDir(): string;
	getCapabilityEnvelope(): CapabilityEnvelope | undefined;
	getCredentialExposureBoundary?(): CredentialExposureBoundary | undefined;
	/** The session's edge grants, as the owner's own shell calls read them: what was allowed ahead, never a prompt answered for one call. */
	getEdgeGrants?(): readonly EdgeGrantView[];
	/** `yolo` skips the edge classes and keeps the execution floor; any other mode classifies every operation. */
	getEdgeMode?(): string | undefined;
	getDenyCommands?(): readonly string[] | undefined;
}

function statOrUndefined(path: string): Stats | undefined {
	try {
		return statSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Whether an operating-system process is running: signal 0 only probes. A process the probe may not signal still exists. */
export function processIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
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
	 * The condition as the session may watch it now, in canonical form (a path's absolute form), or an error naming the
	 * authority it lacks. This is the part applied at every evaluation: it checks authority only, never whether the
	 * watched thing still exists, so a file that vanished or a process that ended is an observation, not a refusal.
	 */
	authorize(condition: WatchCondition): WatchCondition {
		switch (condition.type) {
			case "file":
				return {
					...condition,
					path: isAbsolute(condition.path) ? resolve(condition.path) : resolve(this.host.getCwd(), condition.path),
				};
			case "command": {
				const refusal = this.commandRefusal(condition.command);
				if (refusal) throw new Error(`A watched command was refused. ${refusal}`);
				return condition;
			}
			case "process":
			case "pid":
			case "port":
			case "http":
				return condition;
		}
	}

	/** {@link authorize} plus what must hold when a watch is saved: the folder, process or pid exists and has not ended. */
	admit(condition: WatchCondition): WatchCondition {
		const authorized = this.authorize(condition);
		if (authorized.type === "file") {
			// The harness's own storage changes whenever it works, so a watch there would fire on its own runs.
			const target = isWatchGlob(authorized.path) ? splitWatchPattern(authorized.path).base : authorized.path;
			if (readScopeRefusal(this.scope(), target, true) === "denied")
				throw new Error("A watch cannot observe the harness's own storage: its writes would trigger the watch.");
			if (isWatchGlob(authorized.path)) {
				const { base } = splitWatchPattern(authorized.path);
				if (dirname(base) === base)
					throw new Error("A glob pattern needs a fixed folder before its first wildcard, not a filesystem root.");
			} else if (!statOrUndefined(authorized.path) && !statOrUndefined(dirname(authorized.path))?.isDirectory())
				throw new Error("The folder of a watched path must exist.");
		} else if (authorized.type === "process") {
			const entry = readEntrySync(this.host.getAgentDir(), authorized.processId);
			if (!entry) throw new Error("No managed process with that id is recorded on this machine.");
			if (entry.terminal !== undefined || entry.status === "closed")
				throw new Error("That managed process has already exited.");
		} else if (authorized.type === "http") {
			// A literal address is checked now; a name that resolves to one is refused at every fetch.
			const host = new URL(authorized.url).hostname.replace(/^\[|\]$/gu, "");
			if (isIP(host) !== 0)
				try {
					assertReachableAddress(host, { reach: "ownedServices" });
				} catch {
					throw new Error("A watched page cannot be on a link-local, multicast, broadcast or reserved address.");
				}
		} else if (authorized.type === "pid") {
			if (!processIsRunning(authorized.pid)) throw new Error("No process with that id is running.");
		}
		return authorized;
	}

	/**
	 * Whether the session may read what `absolutePath` holds: inside its read scope and not private to the harness or
	 * credential-bearing. Only then is a path's content digested; elsewhere it is observed by metadata alone.
	 */
	readsContent(absolutePath: string): boolean {
		const scope = this.scope();
		return (
			readScopeRefusal(scope, absolutePath) === undefined &&
			!isProtectedCredentialPath(absolutePath, scope.cwd, this.boundary(scope))
		);
	}

	/**
	 * Why the session's own shell would not run `command` unasked, as a sentence, or undefined when it may run on a
	 * watch's cadence. The deterministic parts of the shell's admission apply (the capability envelope, credential
	 * protection and the edge classes); what needs the owner's answer at the time is refused, because nobody is there.
	 */
	commandRefusal(command: string): string | undefined {
		const scope = this.scope();
		const cwd = scope.cwd;
		const envelope = this.host.getCapabilityEnvelope();
		if (envelope) {
			const outcome = evaluateToolGate({ toolName: "bash", args: { command }, cwd, scopeCwd: cwd, envelope });
			if (outcome.outcome !== "allow")
				return outcome.message ?? "The session's capability envelope does not allow shell commands.";
		}
		const credential = credentialToolBlockReason("bash", { command }, cwd, this.boundary(scope));
		if (credential) return credential;
		if (this.host.getEdgeMode?.() === "yolo") {
			const floor = classifyYoloBoundary({
				toolName: "bash",
				args: { command },
				cwd,
				scopeCwd: cwd,
				denyCommands: this.host.getDenyCommands?.(),
			});
			return floor
				? `This command ${floor.reason}, which needs the owner's approval each time and a watch cannot ask.`
				: undefined;
		}
		const grants = this.host.getEdgeGrants?.() ?? [];
		const ungranted = classifyAllEdgeOperations(
			{ toolName: "bash", args: { command }, cwd, scopeCwd: cwd },
			{ includeConditional: true },
		).find((operation) => !isEdgeOperationGranted(operation, grants));
		return ungranted
			? `This command ${ungranted.reason}, which needs the owner's approval and a watch cannot ask (a grant of ${ungranted.class} allows it).`
			: undefined;
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

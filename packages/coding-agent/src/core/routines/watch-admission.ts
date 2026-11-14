/**
 * What a session may watch. The same rules admit a watch when it is saved and apply again at every evaluation, so a
 * condition saved earlier is never evaluated with more authority than the session has now:
 * - a path (a file, a folder or a glob pattern) is observed through its metadata, which needs no read authority; its
 *   content is digested only where the session's read scope and the credential policy allow reading it;
 * - a command passes the admission the owner's own shell calls pass (the capability envelope, credential protection,
 *   edge classification against the session's edge grants, and the read-only line of a session whose shell edits
 *   nothing), non-interactively: whatever would ask the owner is refused, since a watch cannot ask. It runs with a
 *   bounded environment;
 * - a managed process is a process-matrix entry that has not ended yet, and an operating-system process must be running.
 * Ports, pages and the cadence are bounded by the condition's own schema; a page's address is checked again at fetch.
 * A watch a worker runtime armed is admitted under the session's authority and the worker's together
 * ({@link WorkerWatchAuthority}): its commands and relative paths start in the worker's directory, each run of its command
 * has a scratch directory of its own as the worker's own bash has (exported as TMPDIR, TMP and TEMP, the one place a
 * read-only shell may create a file, removed after the run), a read-only worker's command passes the worker's read-only
 * shell scope and runs with its environment restrictions, a page needs the worker's
 * `network.http` and reaches what its fetch tool reaches, a path's content is digested only inside the worker's read
 * scope, and a runtime that carries a third party's words acts only under the owner's standing grants.
 */

import { type Stats, statSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import type { CapabilityEnvelope } from "../autonomy/contracts.ts";
import {
	classifyAllEdgeOperations,
	classifyOutwardEdgeOperations,
	classifyYoloBoundary,
	type EdgeGrantView,
	isEdgeOperationGranted,
	type ProtectedWritePaths,
} from "../autonomy/edge-policy.ts";
import { evaluateToolGate } from "../autonomy/gates.ts";
import {
	insideLaneReadRoots,
	laneReadOnlyShellScope,
	laneReadRoots,
	laneRunsOffline,
} from "../autonomy/lane-shell-scope.ts";
import { safeRealpathSync } from "../autonomy/path-scope.ts";
import type { SessionConfinement } from "../autonomy/session-confinement.ts";
import {
	privatePathBoundary,
	readScopeRefusal,
	type SessionReadScope,
	sessionReadScope,
} from "../autonomy/session-read-scope.ts";
import { workerCommandRestrictions } from "../autonomy/worker-run-environment.ts";
import { readOnlyShellViolation } from "../model-router/read-only-shell-policy.ts";
import { refuseLocalPush } from "../objective-execution/local-commit-delivery.ts";
import { readEntrySync } from "../process-matrix/store.ts";
import { createProcessScratchDirectory, removeProcessScratchDirectory } from "../process-scratch.ts";
import {
	type CredentialExposureBoundary,
	credentialToolBlockReason,
	isProtectedCredentialPath,
} from "../secrets/credential-exposure-guard.ts";
import { assertReachableAddress, type PublicWebPolicy } from "../web/public-web-client.ts";
import { isWatchGlob, splitWatchPattern, type WatchCondition } from "./watch-contract.ts";
import { type WorkerWatchAuthority, watchCheckCall } from "./worker-watch-scope.ts";

export interface WatchAdmissionHost {
	getCwd(): string;
	getAgentDir(): string;
	getCapabilityEnvelope(): CapabilityEnvelope | undefined;
	getCredentialExposureBoundary?(): CredentialExposureBoundary | undefined;
	/**
	 * What confines the session's own tools (a confined bot's session): the read-only line its shell is held to, which
	 * judges a watched command at arming and at every run, and the roots it reads in, which a watched path's content stays in.
	 */
	getSessionConfinement?(): SessionConfinement | undefined;
	/**
	 * The session's edge grants, as the owner's own shell calls read them: what was allowed ahead, never a prompt answered
	 * for one call; `standingOnly` keeps the owner's standing grants alone, all a run carrying a third party's words may use.
	 */
	getEdgeGrants?(standingOnly?: boolean): readonly EdgeGrantView[];
	/** `yolo` skips the edge classes and keeps the execution floor; any other mode classifies every operation. */
	getEdgeMode?(): string | undefined;
	getDenyCommands?(): readonly string[] | undefined;
	/** The branch the owner bound local commits to: a push is refused in every mode while it is set. */
	localCommitBranch?(): string | undefined;
	/** Whether a worker runtime's conversation carries a third party's words now; a host that cannot tell admits no worker's watch. */
	workerCarriesThirdPartyWords?(runtimeId: string): boolean;
	/** What a run carrying a third party's words may write only under a grant, or never, from `cwd`. */
	thirdPartyProtectedWrites?(cwd: string): ProtectedWritePaths;
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

/**
 * The scratch directory one run of a worker's watched command has, as the worker's own bash has one
 * (`createWorkerRunEnvironment`): exported to the command as TMPDIR, TMP and TEMP and the one place a read-only shell
 * may create a file (`roots`: as exported, then canonical). `release` removes it once the run ended.
 */
export interface WatchCommandScratch {
	readonly path: string;
	readonly roots: readonly string[];
	release(): void;
}

const WATCH_SCRATCH_PREFIX = "watch-";

export class WatchAdmission {
	private readonly host: WatchAdmissionHost;

	constructor(host: WatchAdmissionHost) {
		this.host = host;
	}

	/** Where a watched command runs and a relative path starts: the worker's directory for a worker's watch. */
	cwd(worker?: WorkerWatchAuthority): string {
		return worker?.scope.cwd ?? this.host.getCwd();
	}

	/**
	 * A scratch directory for one run of a worker's watched command; none for any other condition, or for a session's
	 * command, which runs as the session's own shell does. The caller releases it once the run ended.
	 */
	commandScratch(condition: WatchCondition, worker?: WorkerWatchAuthority): WatchCommandScratch | undefined {
		if (condition.type !== "command" || !worker) return undefined;
		const path = createProcessScratchDirectory(WATCH_SCRATCH_PREFIX);
		return {
			path,
			roots: [...new Set([path, safeRealpathSync(path)])],
			release: () => removeProcessScratchDirectory(path),
		};
	}

	/**
	 * The environment a watched command runs with: the bounded one, closed further where the worker's own commands are,
	 * with the run's scratch directory as its temporary directory.
	 */
	commandEnvironment(worker?: WorkerWatchAuthority, scratch?: WatchCommandScratch): NodeJS.ProcessEnv {
		const env = watchCommandEnvironment();
		if (!worker) return env;
		const { scope } = worker;
		return {
			...env,
			...(scratch ? { TMPDIR: scratch.path, TMP: scratch.path, TEMP: scratch.path } : {}),
			...workerCommandRestrictions({ offline: laneRunsOffline(scope), readOnly: scope.readOnly }, env),
		};
	}

	/** What a watched page may reach: the services the owner runs for a session's watch, what a worker's fetch tool reaches for a worker's. */
	webPolicy(worker?: WorkerWatchAuthority): PublicWebPolicy {
		return { reach: worker ? "public" : "ownedServices" };
	}

	private scope(): SessionReadScope {
		const confined = this.host.getSessionConfinement?.()?.readScope;
		if (confined) return confined;
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
	authorize(condition: WatchCondition, worker?: WorkerWatchAuthority, scratch?: WatchCommandScratch): WatchCondition {
		switch (condition.type) {
			case "file":
				return {
					...condition,
					path: isAbsolute(condition.path) ? resolve(condition.path) : resolve(this.cwd(worker), condition.path),
				};
			case "command": {
				// A command that cannot start says nothing at every check, so a worker's vanished directory is a refusal.
				if (worker && !statOrUndefined(worker.scope.cwd)?.isDirectory())
					throw new Error("The directory of the worker that armed this watched command no longer exists.");
				const refusal = this.commandRefusal(condition.command, worker, scratch);
				if (refusal) throw new Error(`A watched command was refused. ${refusal}`);
				return condition;
			}
			case "http": {
				if (worker && !worker.scope.network)
					throw new Error("A watched page was refused: the worker that armed it holds no network.http grant.");
				const call = watchCheckCall(condition);
				const refusal = worker && call && this.thirdPartyRefusal(worker, call.toolName, call.args);
				if (refusal) throw new Error(`A watched page was refused. ${refusal}`);
				return condition;
			}
			case "process":
			case "pid":
			case "port":
				return condition;
		}
	}

	/**
	 * {@link authorize} plus what must hold when a watch is saved: the folder, process or pid exists and has not ended. A
	 * worker's command is judged as at every run, with a scratch directory of its own.
	 */
	admit(condition: WatchCondition, worker?: WorkerWatchAuthority): WatchCondition {
		const scratch = this.commandScratch(condition, worker);
		let authorized: WatchCondition;
		try {
			authorized = this.authorize(condition, worker, scratch);
		} finally {
			scratch?.release();
		}
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
					assertReachableAddress(host, this.webPolicy(worker));
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
	readsContent(absolutePath: string, worker?: WorkerWatchAuthority): boolean {
		const scope = this.scope();
		if (
			readScopeRefusal(scope, absolutePath) !== undefined ||
			isProtectedCredentialPath(absolutePath, scope.cwd, this.boundary(scope))
		)
			return false;
		if (!worker) return true;
		const { cwd, deniedPaths, readRoots } = worker.scope;
		const roots = laneReadRoots(readRoots);
		return (
			!isProtectedCredentialPath(absolutePath, cwd, privatePathBoundary(deniedPaths, cwd)) &&
			(roots === undefined || insideLaneReadRoots(absolutePath, roots))
		);
	}

	/**
	 * Why the session's own shell would not run `command` unasked, as a sentence, or undefined when it may run on a
	 * watch's cadence. The deterministic parts of the shell's admission apply (the capability envelope, credential
	 * protection and the edge classes); what needs the owner's answer at the time is refused, because nobody is there.
	 */
	commandRefusal(command: string, worker?: WorkerWatchAuthority, scratch?: WatchCommandScratch): string | undefined {
		const scope = this.scope();
		const scopeCwd = scope.cwd;
		const cwd = this.cwd(worker);
		const args = { command };
		const localPush = this.host.localCommitBranch;
		const push = refuseLocalPush(localPush ? { branch: () => localPush() } : undefined, "bash", args);
		if (push) return push.reason;
		const envelope = this.host.getCapabilityEnvelope();
		if (envelope) {
			const outcome = evaluateToolGate({ toolName: "bash", args, cwd, scopeCwd, envelope });
			if (outcome.outcome !== "allow")
				return outcome.message ?? "The session's capability envelope does not allow shell commands.";
		}
		const credential = credentialToolBlockReason("bash", args, cwd, this.boundary(scope));
		if (credential) return credential;
		const sessionShell = this.host.getSessionConfinement?.()?.readOnlyShell;
		const sessionViolation =
			sessionShell && readOnlyShellViolation(command, cwd, { lane: sessionShell, dialect: "posix" });
		if (sessionViolation) return `This session has a read-only shell: ${sessionViolation}.`;
		if (worker) {
			const refusal =
				this.workerShellRefusal(command, worker, scratch) ?? this.thirdPartyRefusal(worker, "bash", args);
			if (refusal) return refusal;
		}
		if (this.host.getEdgeMode?.() === "yolo") {
			const denyCommands = this.host.getDenyCommands?.();
			const floor = classifyYoloBoundary({ toolName: "bash", args, cwd, scopeCwd, denyCommands });
			return floor
				? `This command ${floor.reason}, which needs the owner's approval each time and a watch cannot ask.`
				: undefined;
		}
		const grants = this.host.getEdgeGrants?.() ?? [];
		const ungranted = classifyAllEdgeOperations(
			{ toolName: "bash", args, cwd, scopeCwd },
			{ includeConditional: true },
		).find((operation) => !isEdgeOperationGranted(operation, grants));
		return ungranted
			? `This command ${ungranted.reason}, which needs the owner's approval and a watch cannot ask (a grant of ${ungranted.class} allows it).`
			: undefined;
	}

	/** Why a read-only worker's own shell would refuse `command`: judged by its read-only scope and the run's scratch directory. */
	private workerShellRefusal(
		command: string,
		worker: WorkerWatchAuthority,
		scratch: WatchCommandScratch | undefined,
	): string | undefined {
		const { scope } = worker;
		if (!scope.shellReadOnly) return undefined;
		const boundary = privatePathBoundary(scope.deniedPaths, scope.cwd);
		const lane = laneReadOnlyShellScope(scope, scratch?.roots ?? [], boundary, laneReadRoots(scope.readRoots));
		const violation = readOnlyShellViolation(command, scope.cwd, { lane, dialect: "posix" });
		return violation ? `The worker that armed it has a read-only shell: ${violation}.` : undefined;
	}

	/**
	 * Why a worker's call would be refused now because its runtime carries a third party's words: outside the owner's
	 * standing grants, as its own gate refuses it (`classifyOutwardEdgeOperations`). Read at every observation, since a steer
	 * can bring such words after the watch was armed; a host that cannot tell refuses.
	 */
	private thirdPartyRefusal(worker: WorkerWatchAuthority, toolName: string, args: unknown): string | undefined {
		const { workerCarriesThirdPartyWords, thirdPartyProtectedWrites } = this.host;
		if (!workerCarriesThirdPartyWords || !thirdPartyProtectedWrites)
			return "This session cannot tell whether the worker that armed it carries a third party's words.";
		if (!workerCarriesThirdPartyWords(worker.runtimeId)) return undefined;
		const cwd = worker.scope.cwd;
		const standing = this.host.getEdgeGrants?.(true) ?? [];
		const ungranted = classifyOutwardEdgeOperations({
			toolName,
			args,
			cwd,
			scopeCwd: this.host.getCwd(),
			protectedWrites: thirdPartyProtectedWrites(cwd),
		}).filter((operation) => !isEdgeOperationGranted(operation, standing));
		return ungranted.length > 0
			? `The worker that armed it carries words written by someone else, and no standing grant of the owner covers ${[...new Set(ungranted.map((operation) => operation.class))].join(", ")}.`
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

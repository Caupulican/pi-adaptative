import { copyFileSync, existsSync, constants as fsConstants, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { SessionManager } from "../kernel/session/session-manager.ts";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import {
	type DiscardDisposition,
	disposeDiscardedSessionUsage,
	finishDiscardedSessionUsage,
	pathNotice,
	releaseDiscardedSessionUsage,
	routeDiscardedSessionUsage,
} from "./cost/semantic-usage-delivery.ts";
import { SEMANTIC_USAGE_CUSTOM_TYPE, SPAWNED_USAGE_CUSTOM_TYPE } from "./cost/usage-records.ts";
import type {
	ExtensionRunner,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

interface AgentSessionRuntimeState {
	session: AgentSession;
	sessionManager: SessionManager;
	getExtensionRunner(): ExtensionRunner;
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
	modelFallbackMessage?: string;
}

interface RuntimeShutdownProgress {
	shutdownEventEmitted: boolean;
	stoppedResources: Set<AgentSessionRuntimeResource>;
	hostInvalidated: boolean;
	sessionDisposed: boolean;
}

/** What a session resource may read about the active session; the runtime that built the session supplies it. */
export interface ActiveSessionContext {
	readonly sessionManager: SessionManager;
	readonly services: AgentSessionServices;
	/** Live: a reload replaces the session's runner, so read this per use. */
	readonly extensionRunner: ExtensionRunner;
}

/** Session-owned background runtime that must not survive a session replacement. */
export interface AgentSessionRuntimeResource {
	start(session: AgentSession, active: ActiveSessionContext): Promise<void>;
	stop(): Promise<void> | void;
}

/** A session together with the live accessor for its extension runner, as shutdown needs both. */
type RuntimeShutdownTarget = Pick<AgentSessionRuntimeState, "session" | "getExtensionRunner">;

/** Internal activation hooks used by the interactive session-resume flow. */
export interface AgentSessionSwitchOptions {
	cwdOverride?: string;
	/** Runs against the installed replacement after host rebind and before supervisors restart. */
	beforeSessionResourcesStart?: (session: AgentSession) => Promise<void> | void;
	withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
}

/**
 * A session file a replacement created. When the replacement is discarded its file goes, unless it holds paid usage rows that
 * no other session records (those stay as evidence). `copiedEntryIds` are the entry ids the file shares with its source (a branch's
 * copied rows keep their source's ids; a byte copy's rows are its source's), captured when the copy was made, or undefined for a
 * new session.
 */
interface CreatedSession {
	readonly sessionManager: SessionManager;
	readonly copiedEntryIds: ReadonlySet<string> | undefined;
}

/** A discard in progress: routed before the candidate is shut down, decided once it is shut down. */
interface PendingDiscard {
	readonly sessionManager: SessionManager;
	readonly created: CreatedSession | undefined;
}

const PAID_ROW_TYPES: ReadonlySet<string> = new Set([SEMANTIC_USAGE_CUSTOM_TYPE, SPAWNED_USAGE_CUSTOM_TYPE]);

/** The entry ids a session file holds: the rows a byte copy of it shares with it. A line that is not JSON holds no entry. */
function entryIdsOfFile(path: string): Set<string> {
	const ids = new Set<string>();
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.trim().length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof parsed === "object" && parsed !== null && "id" in parsed && typeof parsed.id === "string") {
			ids.add(parsed.id);
		}
	}
	return ids;
}

/** The entry ids a session manager holds, as a copy of it shares them. */
function entryIdsOfManager(manager: SessionManager): ReadonlySet<string> {
	return new Set(manager.getEntries().map((entry) => entry.id));
}

/**
 * Paid usage rows the created session's file holds that no other session records. A row counts when the file holds its line,
 * whatever the line's content or length: a buffered row is not in the file (its retained journal copy, if any, is the
 * disclosure), and a row the file shares with its source (`copiedEntryIds`) is recorded by that source. A file that cannot be
 * read has unknown rows: the caller keeps it.
 */
function countUniquePaidRows(created: CreatedSession): { readonly rows: number } | { readonly unreadable: unknown } {
	const { copiedEntryIds, sessionManager } = created;
	try {
		const rows = sessionManager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "custom" &&
					PAID_ROW_TYPES.has(entry.customType) &&
					!copiedEntryIds?.has(entry.id) &&
					sessionManager.hasEntryInFile(entry.id),
			).length;
		return { rows };
	} catch (error: unknown) {
		return { unreadable: error };
	}
}

/**
 * A runtime factory that failed after it created the session: the session is handed back, so the runtime disposes it in full
 * (its extensions, shell and usage owner) instead of leaking it. `cause` is the failure itself.
 */
export class CreatedSessionFailure extends Error {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;

	constructor(session: AgentSession, sessionManager: SessionManager, cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = "CreatedSessionFailure";
		this.session = session;
		this.sessionManager = sessionManager;
	}
}

/**
 * Disposes a session a failed startup handed back. No runtime exists to take its warnings, so they join the error the caller
 * shows; a failed disposal is reported with the cause rather than replacing it.
 */
async function disposeAbandonedSession(failure: CreatedSessionFailure): Promise<unknown> {
	const handoff: string[] = [];
	routeDiscardedSessionUsage(failure.sessionManager, (message) => handoff.push(message));
	let disposeError: unknown;
	try {
		await failure.session.disposeAndWait();
	} catch (error: unknown) {
		disposeError = error;
	}
	// Taken after the disposal, which is what raises the session's own late warnings; the owner's handoff follows its disposal.
	handoff.push(...failure.session.takeUndeliveredWarnings());
	disposeDiscardedSessionUsage(failure.sessionManager);
	finishDiscardedSessionUsage(failure.sessionManager, "none");
	releaseDiscardedSessionUsage(failure.sessionManager);
	if (disposeError !== undefined) {
		return new AggregateError(
			[failure.cause, disposeError],
			"Session creation failed, and the created session could not be disposed.",
		);
	}
	if (handoff.length === 0) return failure.cause;
	const cause = failure.cause instanceof Error ? failure.cause.message : String(failure.cause);
	return new Error(`${cause} ${handoff.join(" ")}`, { cause: failure.cause });
}

/** The failure a runtime factory raised, without the session it handed back. */
function unwrapCreation(error: unknown): unknown {
	return error instanceof CreatedSessionFailure ? error.cause : error;
}

interface SessionReplacementCommitOptions {
	reason: SessionShutdownEvent["reason"];
	targetSessionFile: string | undefined;
	beforeSessionResourcesStart?: (session: AgentSession) => Promise<void> | void;
	withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	createdSession?: CreatedSession;
}

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
}) => Promise<CreateAgentSessionRuntimeResult>;

/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

/** Why a replacement could not be restored, and the routed warnings no live session received. */
interface RestoreFailure {
	readonly error: unknown;
	readonly undeliveredWarnings: readonly string[];
}

/** A teardown or activation failure at the replacement boundary, including rollback outcome. */
export class SessionReplacementRuntimeError extends Error {
	readonly phase: "teardown" | "activation";
	readonly recovered: boolean;
	readonly transitionError: unknown;
	readonly recoveryError: unknown | undefined;
	/** Warnings of the discarded session that no live session could take: a failed restore leaves none to show them on. */
	readonly undeliveredWarnings: readonly string[];

	constructor(
		phase: "teardown" | "activation",
		transitionError: unknown,
		recovered: boolean,
		recoveryError?: unknown,
		undeliveredWarnings: readonly string[] = [],
	) {
		const transitionMessage = transitionError instanceof Error ? transitionError.message : String(transitionError);
		const warnings = undeliveredWarnings.length > 0 ? `. ${undeliveredWarnings.join(" ")}` : "";
		super(
			recovered
				? `Session replacement ${phase} failed; the previous session was restored: ${transitionMessage}`
				: `Session replacement ${phase} failed and the previous session could not be restored safely: ${transitionMessage}${warnings}`,
		);
		this.name = "SessionReplacementRuntimeError";
		this.phase = phase;
		this.recovered = recovered;
		this.transitionError = transitionError;
		this.recoveryError = recoveryError;
		this.undeliveredWarnings = undeliveredWarnings;
	}
}

/** A post-commit extension callback failed; the replacement itself remains the active session. */
export class SessionReplacementCallbackError extends Error {
	readonly replacementCommitted = true;
	readonly callbackError: unknown;

	constructor(callbackError: unknown) {
		const callbackMessage = callbackError instanceof Error ? callbackError.message : String(callbackError);
		super(`Session replacement completed, but its withSession callback failed: ${callbackMessage}`);
		this.name = "SessionReplacementCallbackError";
		this.callbackError = callbackError;
	}
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/**
 * Owns the current AgentSession plus its cwd-bound services.
 *
 * Session replacement methods construct the candidate runtime before retiring
 * the current one. If preparation fails, the working session remains active.
 */
export class AgentSessionRuntime implements ActiveSessionContext {
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private _session: AgentSession;
	private _sessionManager: SessionManager;
	private _getExtensionRunner: () => ExtensionRunner;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	/** Warnings of discarded sessions, delivered on the live session once one exists. */
	private readonly discardedWarnings: string[] = [];
	/** Discarded candidates whose own held warnings are taken once they are shut down. */
	private readonly discardedSessions: AgentSession[] = [];
	/** Discarded candidates whose owners still route warnings here, until the final take. */
	private readonly discardedManagers: SessionManager[] = [];
	private _modelFallbackMessage?: string;
	private _replacementInFlight: Promise<unknown> | undefined;
	private _disposeInFlight: Promise<void> | undefined;
	private _disposeStarted = false;
	private _disposed = false;
	private readonly disposeProgress: RuntimeShutdownProgress = {
		shutdownEventEmitted: false,
		stoppedResources: new Set(),
		hostInvalidated: false,
		sessionDisposed: false,
	};
	private readonly sessionResources: AgentSessionRuntimeResource[] = [];

	constructor(initial: CreateAgentSessionRuntimeResult, createRuntime: CreateAgentSessionRuntimeFactory) {
		this._session = initial.session;
		this._sessionManager = initial.sessionManager;
		this._getExtensionRunner = initial.getExtensionRunner;
		this._services = initial.services;
		this.createRuntime = createRuntime;
		this._diagnostics = initial.diagnostics;
		this._modelFallbackMessage = initial.modelFallbackMessage;
	}

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	/** The current session's manager; replaced together with the session. */
	get sessionManager(): SessionManager {
		return this._sessionManager;
	}

	/** The current session's extension runner; a reload swaps it, so read it per use. */
	get extensionRunner(): ExtensionRunner {
		return this._getExtensionRunner();
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	/** True from replacement admission until rebind and replacement callbacks have settled. */
	get isReplacing(): boolean {
		return this._replacementInFlight !== undefined;
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching extension-provided TUI components before the old extension
	 * context becomes stale.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	/** Register a resource whose lifecycle follows the active session (supervisors, watchers). */
	registerSessionResource(resource: AgentSessionRuntimeResource): void {
		if (this.sessionResources.includes(resource)) return;
		this.sessionResources.push(resource);
	}

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	private async teardownCurrent(reason: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void> {
		const errors = await this.shutdownRuntime(this.currentTarget(), reason, targetSessionFile, {
			stopResources: true,
			invalidateHost: true,
		});
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Session runtime teardown failed.");
	}

	private async discardPrepared(result: { readonly session: AgentSession }): Promise<void> {
		await result.session.disposeAndWait();
	}

	/**
	 * Removes the created session file of a rejected replacement, best effort. Only the file goes: its usage-journal sidecar
	 * holds paid usage with no canonical row, so it stays as unmatched recovery evidence, and its owner's handoff names it.
	 */
	private removeCreatedSessionFile(sessionFile: string | undefined): void {
		if (!sessionFile || sessionFile === this.session.sessionFile) return;
		try {
			unlinkSync(sessionFile);
		} catch {
			// Best-effort rollback of an artifact created solely for the rejected replacement.
		}
	}

	/**
	 * Routes a discarded candidate's warnings to the surviving session: its owner's handoff once its file is decided, and the
	 * warnings its own lifecycle holds (raised before this route, or during its shutdown) when they are taken.
	 */
	private beginDiscard(candidate: {
		session?: AgentSession;
		sessionManager: SessionManager;
		created?: CreatedSession;
	}): PendingDiscard {
		if (candidate.session) this.discardedSessions.push(candidate.session);
		this.discardedManagers.push(candidate.sessionManager);
		routeDiscardedSessionUsage(candidate.sessionManager, (message) => this.discardedWarnings.push(message));
		return { sessionManager: candidate.sessionManager, created: candidate.created };
	}

	/**
	 * Decides a discard's file once the candidate is shut down, so the rows its final pass persisted count as kept. The file goes
	 * only when it is readable and holds no row that no other session records; otherwise it stays, with a notice naming why.
	 * The owner's handoff is produced with the same disposition.
	 */
	private finishDiscard(discard: PendingDiscard): void {
		const { created, sessionManager } = discard;
		disposeDiscardedSessionUsage(sessionManager);
		if (created === undefined) {
			finishDiscardedSessionUsage(sessionManager, "none");
			return;
		}
		const path = sessionManager.getSessionFile();
		const counted = countUniquePaidRows(created);
		const disposition: DiscardDisposition = "unreadable" in counted || counted.rows > 0 ? "kept" : "removed";
		finishDiscardedSessionUsage(sessionManager, disposition);
		if (disposition === "removed") this.removeCreatedSessionFile(path);
		else if (path !== undefined) {
			this.discardedWarnings.push(
				"unreadable" in counted
					? pathNotice(
							"Usage handoff: the paid usage rows of ",
							path,
							` could not be read back (${counted.unreadable instanceof Error ? counted.unreadable.message : String(counted.unreadable)}), so this rejected replacement's session file is kept as recovery evidence.`,
						)
					: pathNotice(
							`Usage handoff: ${counted.rows} paid usage row(s) are present in `,
							path,
							", a session file of a rejected replacement kept because no other session records them.",
						),
			);
		}
	}

	/** Delivers the routed warnings on the live session: called only once a live session exists to receive them. */
	private flushDiscardedWarnings(): void {
		for (const message of this.takeDiscardedWarnings()) this.session.emitHostWarning(message);
	}

	/** Every routed warning, in the order it was raised or taken; a session's held warnings are taken once. */
	private takeDiscardedWarnings(): string[] {
		for (const session of this.discardedSessions.splice(0)) {
			this.discardedWarnings.push(...session.takeUndeliveredWarnings());
		}
		// The final take ends the route: a late warning of a discarded owner is held by that owner, not shown at a later flush.
		for (const manager of this.discardedManagers.splice(0)) releaseDiscardedSessionUsage(manager);
		return this.discardedWarnings.splice(0);
	}

	/** A fork that replaces this session. The new session file goes when its preparation or its commit fails. */
	private async replaceWithFork(
		sessionManager: SessionManager,
		previousSessionFile: string | undefined,
		withSession: SessionReplacementCommitOptions["withSession"],
		copiedEntryIds: ReadonlySet<string> | undefined,
	): Promise<void> {
		const prepared = await this.prepareReplacement(
			sessionManager,
			{ type: "session_start", reason: "fork", previousSessionFile },
			{ sessionManager, copiedEntryIds },
		);
		await this.commitReplacement(prepared, {
			reason: "fork",
			targetSessionFile: sessionManager.getSessionFile(),
			withSession,
			createdSession: { sessionManager, copiedEntryIds },
		});
	}

	/**
	 * Discards a candidate that never became active. Its owner is routed to the live session first; a session a failed factory
	 * handed back is then disposed in full (through the path discardPrepared uses); last, its file is decided: removed, or kept
	 * when it holds rows no other session records. If the disposal itself fails, both failures are reported.
	 */
	private async discardCreatedSession(
		sessionManager: SessionManager,
		created: CreatedSession | undefined,
		error: unknown,
		handed?: AgentSession,
	): Promise<void> {
		const session = error instanceof CreatedSessionFailure ? error.session : handed;
		const discard = this.beginDiscard({ session, sessionManager, created });
		let disposalError: unknown;
		if (session) {
			try {
				await this.discardPrepared({ session });
			} catch (failure: unknown) {
				disposalError = failure;
			}
		}
		this.finishDiscard(discard);
		this.flushDiscardedWarnings();
		if (disposalError !== undefined) {
			throw new AggregateError(
				[unwrapCreation(error), disposalError],
				"Session creation failed, and the created session could not be disposed.",
			);
		}
	}

	/** Creates the candidate's runtime. A failure discards the candidate (see discardCreatedSession) and is rethrown as the factory raised it. */
	private async prepareReplacement(
		sessionManager: SessionManager,
		sessionStartEvent: SessionStartEvent,
		created: CreatedSession | undefined,
	): Promise<CreateAgentSessionRuntimeResult> {
		try {
			return await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent,
			});
		} catch (error: unknown) {
			await this.discardCreatedSession(sessionManager, created, error);
			throw unwrapCreation(error);
		}
	}

	private async commitReplacement(
		result: CreateAgentSessionRuntimeResult,
		options: SessionReplacementCommitOptions,
	): Promise<void> {
		const previous = this.snapshot();
		try {
			await this.teardownCurrent(options.reason, options.targetSessionFile);
		} catch (transitionError: unknown) {
			const restore = await this.restorePreviousAfterRuntimeFailure(previous, result, options, false);
			throw new SessionReplacementRuntimeError(
				"teardown",
				transitionError,
				restore === undefined,
				restore?.error,
				restore?.undeliveredWarnings,
			);
		}
		this.apply(result);
		try {
			await this.activateReplacement(options);
		} catch (activationError: unknown) {
			const restore = await this.restorePreviousAfterRuntimeFailure(previous, result, options, true);
			throw new SessionReplacementRuntimeError(
				"activation",
				activationError,
				restore === undefined,
				restore?.error,
				restore?.undeliveredWarnings,
			);
		}
		if (options.withSession) {
			try {
				await options.withSession(this.session.createReplacedSessionContext());
			} catch (callbackError: unknown) {
				throw new SessionReplacementCallbackError(callbackError);
			}
		}
	}

	private currentTarget(): RuntimeShutdownTarget {
		return { session: this._session, getExtensionRunner: this._getExtensionRunner };
	}

	private snapshot(): AgentSessionRuntimeState {
		return {
			session: this._session,
			sessionManager: this._sessionManager,
			getExtensionRunner: this._getExtensionRunner,
			services: this._services,
			diagnostics: [...this._diagnostics],
			...(this._modelFallbackMessage !== undefined ? { modelFallbackMessage: this._modelFallbackMessage } : {}),
		};
	}

	private apply(result: AgentSessionRuntimeState): void {
		this._session = result.session;
		this._sessionManager = result.sessionManager;
		this._getExtensionRunner = result.getExtensionRunner;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
	}

	private async activateReplacement(options: SessionReplacementCommitOptions): Promise<void> {
		if (this.rebindSession) {
			await this.rebindSession(this.session);
		}
		await options.beforeSessionResourcesStart?.(this.session);
		for (const resource of this.sessionResources) await resource.start(this.session, this);
	}

	private async restorePreviousAfterRuntimeFailure(
		previous: AgentSessionRuntimeState,
		failed: CreateAgentSessionRuntimeResult,
		options: SessionReplacementCommitOptions,
		candidateActivated: boolean,
	): Promise<RestoreFailure | undefined> {
		// The candidate's owner handoff is produced when shutdown disposes it: it is routed before that, and delivered once the
		// restored session is live (the previous session was disposed at the commit boundary).
		const discard = this.beginDiscard({
			session: failed.session,
			sessionManager: failed.sessionManager,
			created: options.createdSession,
		});
		const cleanupErrors = await this.shutdownRuntime(failed, options.reason, previous.session.sessionFile, {
			stopResources: candidateActivated,
			invalidateHost: candidateActivated,
		});
		// The old AgentSession was disposed at the commit boundary, but its SessionManager remains the
		// durable reconstruction source. Restore the old snapshot temporarily so rollback-only artifact
		// cleanup cannot mistake the failed candidate for the active session.
		this.apply(previous);
		try {
			this.finishDiscard(discard);
		} catch (error: unknown) {
			cleanupErrors.push(error);
		}

		let restored: CreateAgentSessionRuntimeResult | undefined;
		try {
			restored = await this.createRuntime({
				cwd: previous.services.cwd,
				agentDir: previous.services.agentDir,
				sessionManager: previous.sessionManager,
				sessionStartEvent: {
					type: "session_start",
					reason: "resume",
					previousSessionFile: failed.session.sessionFile,
				},
			});
			this.apply(restored);
			if (this.rebindSession) await this.rebindSession(this.session);
			for (const resource of this.sessionResources) await resource.start(this.session, this);
			// Only a fully restored session takes the warnings; a failure before this keeps them for the error the host shows.
			this.flushDiscardedWarnings();
		} catch (recoveryError: unknown) {
			if (restored) {
				cleanupErrors.push(
					...(await this.shutdownRuntime(restored, "resume", failed.session.sessionFile, {
						stopResources: true,
						invalidateHost: true,
					})),
				);
			} else if (recoveryError instanceof CreatedSessionFailure) {
				// The restore factory created the session before it failed: that session is handed back, so it is disposed here.
				const handedBack = this.beginDiscard({
					session: recoveryError.session,
					sessionManager: recoveryError.sessionManager,
				});
				try {
					await this.discardPrepared({ session: recoveryError.session });
				} catch (disposeError: unknown) {
					cleanupErrors.push(disposeError);
				}
				this.finishDiscard(handedBack);
			}
			this.apply(previous);
			// No restored session survives this failure: the routed warnings travel with the error the host renders.
			return {
				error:
					cleanupErrors.length > 0
						? new AggregateError(
								[...cleanupErrors, unwrapCreation(recoveryError)],
								"Session rollback and cleanup failed.",
							)
						: unwrapCreation(recoveryError),
				undeliveredWarnings: this.takeDiscardedWarnings(),
			};
		}

		return cleanupErrors.length > 0
			? {
					error: new AggregateError(
						cleanupErrors,
						"The previous session was restored, but failed replacement cleanup was incomplete.",
					),
					undeliveredWarnings: [],
				}
			: undefined;
	}

	private async shutdownRuntime(
		target: RuntimeShutdownTarget,
		reason: SessionShutdownEvent["reason"],
		targetSessionFile: string | undefined,
		options: { stopResources: boolean; invalidateHost: boolean; progress?: RuntimeShutdownProgress },
	): Promise<unknown[]> {
		const errors: unknown[] = [];
		const progress =
			options.progress ??
			({
				shutdownEventEmitted: false,
				stoppedResources: new Set(),
				hostInvalidated: false,
				sessionDisposed: false,
			} satisfies RuntimeShutdownProgress);
		if (!progress.shutdownEventEmitted) {
			try {
				await emitSessionShutdownEvent(target.getExtensionRunner(), {
					type: "session_shutdown",
					reason,
					targetSessionFile,
				});
				progress.shutdownEventEmitted = true;
			} catch (error: unknown) {
				errors.push(error);
			}
		}
		if (options.stopResources) {
			for (const resource of this.sessionResources) {
				if (progress.stoppedResources.has(resource)) continue;
				try {
					await resource.stop();
					progress.stoppedResources.add(resource);
				} catch (error: unknown) {
					errors.push(error);
				}
			}
		}
		if (options.invalidateHost && !progress.hostInvalidated) {
			try {
				this.beforeSessionInvalidate?.();
				progress.hostInvalidated = true;
			} catch (error: unknown) {
				errors.push(error);
			}
		}
		if (!progress.sessionDisposed) {
			try {
				await target.session.disposeAndWait();
				progress.sessionDisposed = true;
			} catch (error: unknown) {
				errors.push(error);
			}
		}
		return errors;
	}

	private runSessionReplacement<T>(operation: () => Promise<T>): Promise<T> {
		if (this._disposeStarted) {
			return Promise.reject(new Error("The session runtime has already been disposed."));
		}
		if (this._replacementInFlight) {
			return Promise.reject(new Error("A session replacement is already in progress."));
		}
		const replacement = Promise.resolve().then(operation);
		this._replacementInFlight = replacement;
		return replacement.finally(() => {
			if (this._replacementInFlight === replacement) this._replacementInFlight = undefined;
		});
	}

	async switchSession(sessionPath: string, options?: AgentSessionSwitchOptions): Promise<{ cancelled: boolean }> {
		return this.runSessionReplacement(() => this.switchSessionUnserialized(sessionPath, options));
	}

	private async switchSessionUnserialized(
		sessionPath: string,
		options?: AgentSessionSwitchOptions,
	): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionManager = SessionManager.open(sessionPath, this.services.agentDir, undefined, options?.cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		const prepared = await this.prepareReplacement(
			sessionManager,
			{ type: "session_start", reason: "resume", previousSessionFile },
			undefined,
		);
		await this.commitReplacement(prepared, {
			reason: "resume",
			targetSessionFile: sessionManager.getSessionFile(),
			beforeSessionResourcesStart: options?.beforeSessionResourcesStart,
			withSession: options?.withSession,
		});
		return { cancelled: false };
	}

	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		return this.runSessionReplacement(() => this.newSessionUnserialized(options));
	}

	private async newSessionUnserialized(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionDir = this.sessionManager.getSessionDir();
		const sessionManager = SessionManager.create(this.cwd, this.services.agentDir, sessionDir);
		if (options?.parentSession) {
			sessionManager.newSession({ parentSession: options.parentSession });
		}

		const prepared = await this.prepareReplacement(
			sessionManager,
			{ type: "session_start", reason: "new", previousSessionFile },
			{ sessionManager, copiedEntryIds: undefined },
		);
		if (options?.setup) {
			try {
				await options.setup(prepared.sessionManager);
				prepared.session.agent.state.messages = prepared.sessionManager.buildSessionContext().messages;
				// New/replacement session (see "session_start" above): a fresh lineage, never the one
				// any pre-existing sanitizer mark was tracking.
				prepared.session.agent.resetSanitizerPrefixHorizon();
			} catch (error) {
				await this.discardCreatedSession(
					sessionManager,
					{ sessionManager, copiedEntryIds: undefined },
					error,
					prepared.session,
				);
				throw error;
			}
		}
		await this.commitReplacement(prepared, {
			reason: "new",
			targetSessionFile: sessionManager.getSessionFile(),
			withSession: options?.withSession,
			createdSession: { sessionManager, copiedEntryIds: undefined },
		});
		return { cancelled: false };
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		return this.runSessionReplacement(() => this.forkUnserialized(entryId, options));
	}

	private async forkUnserialized(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}
		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const selectedEntry = this.sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		const previousSessionFile = this.session.sessionFile;
		if (this.sessionManager.isPersisted()) {
			const currentSessionFile = this.session.sessionFile;
			if (!currentSessionFile) {
				throw new Error("Persisted session is missing a session file");
			}
			const sessionDir = this.sessionManager.getSessionDir();
			if (!targetLeafId) {
				const sessionManager = SessionManager.create(this.cwd, this.services.agentDir, sessionDir);
				sessionManager.newSession({ parentSession: currentSessionFile });
				await this.replaceWithFork(sessionManager, previousSessionFile, options?.withSession, undefined);
				return { cancelled: false, selectedText };
			}
			if (!existsSync(currentSessionFile)) {
				throw new Error(
					"This session has not been saved yet. Wait for the first assistant response before cloning or forking it.",
				);
			}

			const sourceSessionManager = SessionManager.open(currentSessionFile, this.services.agentDir, sessionDir);
			const sessionManager = sourceSessionManager.createBranchedSessionManager(targetLeafId);
			const forkedSessionPath = sessionManager.getSessionFile();
			if (!forkedSessionPath) {
				throw new Error("Failed to create forked session");
			}
			await this.replaceWithFork(
				sessionManager,
				previousSessionFile,
				options?.withSession,
				entryIdsOfManager(sourceSessionManager),
			);
			return { cancelled: false, selectedText };
		}

		let sessionManager: SessionManager;
		let forkedEntryIds: ReadonlySet<string> | undefined;
		if (!targetLeafId) {
			sessionManager = SessionManager.inMemory(this.cwd);
			sessionManager.newSession({ parentSession: this.session.sessionFile });
		} else {
			sessionManager = this.sessionManager.createBranchedSessionManager(targetLeafId);
			forkedEntryIds = entryIdsOfManager(this.sessionManager);
		}
		const prepared = await this.prepareReplacement(
			sessionManager,
			{ type: "session_start", reason: "fork", previousSessionFile },
			{ sessionManager, copiedEntryIds: forkedEntryIds },
		);
		await this.commitReplacement(prepared, {
			reason: "fork",
			targetSessionFile: sessionManager.getSessionFile(),
			withSession: options?.withSession,
			createdSession: { sessionManager, copiedEntryIds: forkedEntryIds },
		});
		return { cancelled: false, selectedText };
	}

	/**
	 * Import a session JSONL file and switch runtime state to the imported session.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		return this.runSessionReplacement(() => this.importFromJsonlUnserialized(inputPath, cwdOverride));
	}

	private async importFromJsonlUnserialized(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const resolvedPath = resolvePath(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		const sessionDir = this.sessionManager.getSessionDir();
		const destinationPath = join(sessionDir, basename(resolvedPath));
		const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		let copied = false;
		if (resolve(destinationPath) !== resolvedPath) {
			if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
			copyFileSync(resolvedPath, destinationPath, fsConstants.COPYFILE_EXCL);
			copied = true;
		}

		let copiedEntryIds: ReadonlySet<string> | undefined;
		let sessionManager: SessionManager;
		try {
			// The copy's own rows, read as the copy was made: a later change to the source file cannot alter what this copy shares with it.
			if (copied) copiedEntryIds = entryIdsOfFile(destinationPath);
			sessionManager = SessionManager.open(destinationPath, this.services.agentDir, sessionDir, cwdOverride);
			assertSessionCwdExists(sessionManager, this.cwd);
		} catch (error) {
			if (copied) this.removeCreatedSessionFile(destinationPath);
			throw error;
		}
		const prepared = await this.prepareReplacement(
			sessionManager,
			{ type: "session_start", reason: "resume", previousSessionFile },
			copied ? { sessionManager, copiedEntryIds } : undefined,
		);
		await this.commitReplacement(prepared, {
			reason: "resume",
			targetSessionFile: sessionManager.getSessionFile(),
			createdSession: copied ? { sessionManager, copiedEntryIds } : undefined,
		});
		return { cancelled: false };
	}

	async dispose(): Promise<void> {
		if (this._disposeInFlight) return this._disposeInFlight;
		if (this._disposed) return;
		this._disposeStarted = true;
		const replacement = this._replacementInFlight;
		const disposal = (async () => {
			if (replacement) {
				try {
					await replacement;
				} catch {
					// Replacement already reports its own error; dispose whichever runtime it left active.
				}
			}
			const errors = await this.shutdownRuntime(this.currentTarget(), "quit", undefined, {
				stopResources: true,
				invalidateHost: true,
				progress: this.disposeProgress,
			});
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "Session runtime disposal failed.");
			this._disposed = true;
		})();
		this._disposeInFlight = disposal;
		try {
			await disposal;
		} finally {
			this._disposeInFlight = undefined;
		}
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /new, /resume, /fork, and import flows.
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
	},
): Promise<AgentSessionRuntime> {
	assertSessionCwdExists(options.sessionManager, options.cwd);
	let result: CreateAgentSessionRuntimeResult;
	try {
		result = await createRuntime(options);
	} catch (error: unknown) {
		if (error instanceof CreatedSessionFailure) throw await disposeAbandonedSession(error);
		throw error;
	}
	return new AgentSessionRuntime(result, createRuntime);
}

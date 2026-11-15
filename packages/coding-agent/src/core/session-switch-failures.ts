/**
 * The failures of a session switch (`AgentSessionRuntime`'s replacement boundary): a teardown, activation or admission
 * failure with its rollback outcome, and a follow-up step that failed after the replacement committed. Each carries the
 * owner-facing message; the phase name itself stays in the debug log. A file a channel or bot host holds is refused
 * here, as an admission failure, before anything is opened.
 */
import { harnessLog } from "../kernel/harness-log.ts";
import { readSessionHeaderResult } from "../kernel/session/session-header.ts";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import { resolvePath } from "../utils/paths.ts";
import { interfaceText } from "./language/interface-text.ts";
import {
	refuseHostedSession,
	SessionHomeChangedError,
	SessionHostedError,
	type SessionStorageRoots,
} from "./orchestration/session-bundle-lifecycle.ts";

/** Owner words for the step a session switch failed in; the phase name itself stays in the debug log. */
const SWITCH_STEP_WORDS: Readonly<Record<SessionReplacementRuntimeError["phase"], string>> = {
	admission: "before the old session was closed",
	teardown: "while closing the old session",
	activation: "while starting the new session",
};

/** A teardown or activation failure at the replacement boundary, including rollback outcome. */
export class SessionReplacementRuntimeError extends Error {
	readonly phase: "admission" | "teardown" | "activation";
	readonly recovered: boolean;
	readonly transitionError: unknown;
	readonly recoveryError: unknown | undefined;
	/** Warnings of the discarded session that no live session could take: a failed restore leaves none to show them on. */
	readonly undeliveredWarnings: readonly string[];

	constructor(
		phase: "admission" | "teardown" | "activation",
		transitionError: unknown,
		recovered: boolean,
		recoveryError?: unknown,
		undeliveredWarnings: readonly string[] = [],
	) {
		const transitionMessage =
			transitionError instanceof SessionHostedError
				? hostedSessionRefusal(transitionError)
				: transitionError instanceof Error
					? transitionError.message
					: String(transitionError);
		const warnings = undeliveredWarnings.length > 0 ? `. ${undeliveredWarnings.join(" ")}` : "";
		harnessLog.debug("ui", "a session switch failed", () => ({ phase, recovered }));
		super(
			// A session a channel or bot host holds is refused with its own one message; nothing was opened.
			phase === "admission" && transitionError instanceof SessionHostedError
				? transitionMessage
				: phase === "admission"
					? `Switching sessions failed ${SWITCH_STEP_WORDS.admission}; the previous session remains active: ${transitionMessage}`
					: recovered
						? `Switching sessions failed ${SWITCH_STEP_WORDS[phase]}; the previous session was restored: ${transitionMessage}`
						: `Switching sessions failed ${SWITCH_STEP_WORDS[phase]}, and the previous session could not be restored safely: ${transitionMessage}${warnings}`,
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

	constructor(callbackError: unknown, stage = "a follow-up step") {
		const callbackMessage = callbackError instanceof Error ? callbackError.message : String(callbackError);
		harnessLog.debug("ui", "a follow-up step after a session switch failed", () => ({ stage }));
		super(`Switching sessions completed, but ${stage} failed: ${callbackMessage}`);
		this.name = "SessionReplacementCallbackError";
		this.callbackError = callbackError;
	}
}

/** The owner's words for a session another process hosts: the phone session the daemon hosts, or a bot's own session. */
export function hostedSessionRefusal(error: SessionHostedError): string {
	const words = interfaceText().sessions.hosted;
	return error.holder.role === "bot-host" ? words.bot(error.holder.pid) : words.phone(error.holder.pid);
}

/**
 * The home change that refused a session's lease (`SessionHomeChangedError`): thrown as it is by a session's creation,
 * or as the recovered admission failure of a switch whose bridge lease it refused before the current session was closed.
 * Undefined for any other failure, a switch whose cleanup failed too included.
 */
export function sessionHomeChangeOf(error: unknown): SessionHomeChangedError | undefined {
	if (error instanceof SessionHomeChangedError) return error;
	const admission = error instanceof SessionReplacementRuntimeError && error.phase === "admission" && error.recovered;
	return admission && error.transitionError instanceof SessionHomeChangedError ? error.transitionError : undefined;
}

/**
 * The owner's words refusing `manager`'s session when a channel or bot host holds it, before anything writes to it;
 * undefined when none does (or it is not persisted). A registry that does not read is thrown.
 */
export function hostedSessionRefusalOf(manager: SessionManager): string | undefined {
	if (!manager.isPersisted()) return undefined;
	try {
		refuseHostedSession(manager.getStorageRoots().orchestrationHome, manager.getSessionId());
		return undefined;
	} catch (error) {
		if (error instanceof SessionHostedError) return hostedSessionRefusal(error);
		throw error;
	}
}

/**
 * Refuse a session file a channel or bot host holds in `roots`, the home it is opened in, before it is opened or copied: a
 * recovered admission failure (the previous session stays active) whose message is the hosted one; nothing is written.
 */
export function refuseHostedSessionFile(roots: SessionStorageRoots, path: string): void {
	const header = readSessionHeaderResult(resolvePath(path));
	if (!header.ok) return;
	try {
		refuseHostedSession(roots.orchestrationHome, header.header.id);
	} catch (error) {
		throw new SessionReplacementRuntimeError("admission", error, true);
	}
}

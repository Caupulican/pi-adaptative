/**
 * The failures of a session switch (`AgentSessionRuntime`'s replacement boundary): a teardown, activation or admission
 * failure with its rollback outcome, and a follow-up step that failed after the replacement committed. Each carries the
 * owner-facing message; the phase name itself stays in the debug log.
 */
import { harnessLog } from "../kernel/harness-log.ts";
import { SessionHostedError } from "./orchestration/session-bundle-lifecycle.ts";

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
		const transitionMessage = transitionError instanceof Error ? transitionError.message : String(transitionError);
		const warnings = undeliveredWarnings.length > 0 ? `. ${undeliveredWarnings.join(" ")}` : "";
		harnessLog.debug("ui", "a session switch failed", () => ({ phase, recovered }));
		super(
			// A session the bot daemon hosts is refused with its own one message; nothing was opened.
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

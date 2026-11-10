/**
 * Stops the detached bot daemon by releasing the lease it renews, and reports what the stop did as facts: the owner's
 * command words them with the interface's words, while a record and a diagnostic keep the English wording. A daemon is
 * never signalled by pid, so a stop leaves the exit to the daemon: it observes the released lease and ends.
 */

import { englishText, type InterfaceText } from "../language/interface-text.ts";
import type { TimerPort } from "../util/timer-port.ts";
import {
	describeLegacyDaemonRetirement,
	type LegacyDaemonRetirement,
	type LegacyDaemonWords,
	retireLegacyBotDaemons,
} from "./bot-daemon-legacy.ts";
import type { PersistentBotTeamStore } from "./persistent-bot-team-store.ts";

/** What a detached daemon stop did, as facts. */
export type BotDaemonStopOutcome =
	| { readonly kind: "released"; readonly pid?: number; readonly legacy: LegacyDaemonRetirement }
	| {
			readonly kind: "not_running";
			/** A lease nobody held was released, so a stale record no longer claims the daemon runs. */
			readonly staleReleased: boolean;
			readonly legacy: LegacyDaemonRetirement;
	  };

/** The words a stop report draws on: the bot-team area. */
export type BotDaemonStopWords = LegacyDaemonWords &
	Pick<InterfaceText["botTeam"], "daemonStopReleased" | "daemonStopNotRunning">;

export interface BotDaemonStopResult {
	/** Whether a daemon was stopped: its lease was held, or an earlier build's daemon was retired. */
	readonly stopped: boolean;
	readonly outcome: BotDaemonStopOutcome;
	readonly detail: string;
}

/** One sentence for what a stop did, in the language of `words`. */
export function describeBotDaemonStop(outcome: BotDaemonStopOutcome, words: BotDaemonStopWords): string {
	const detail =
		outcome.kind === "released"
			? words.daemonStopReleased(outcome.pid)
			: words.daemonStopNotRunning(outcome.staleReleased);
	const legacy = describeLegacyDaemonRetirement(outcome.legacy, words);
	return legacy === "" ? detail : `${detail} ${legacy}`;
}

/**
 * Releases the lease the detached daemon renews, then retires any earlier build's daemon that still runs. A daemon of
 * this build exits as soon as it observes the released lease.
 */
export function stopDetachedBotDaemon(store: PersistentBotTeamStore, clock: TimerPort): BotDaemonStopResult {
	store.reload();
	const released = store.releaseDaemonLease(undefined, clock.now());
	const legacy = retireLegacyBotDaemons(store);
	const legacyStopped = legacy.releasedTokenDaemon?.held === true || legacy.sweep.signalled.length > 0;
	const heldDaemonStopped = released.released && released.held;
	const outcome: BotDaemonStopOutcome = heldDaemonStopped
		? { kind: "released", ...(released.pid !== undefined ? { pid: released.pid } : {}), legacy }
		: { kind: "not_running", staleReleased: released.released, legacy };
	return {
		stopped: heldDaemonStopped || legacyStopped,
		outcome,
		detail: describeBotDaemonStop(outcome, englishText().botTeam),
	};
}

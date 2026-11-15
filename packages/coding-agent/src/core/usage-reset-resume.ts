/**
 * What a root session does when a run ends on its provider's usage limit. A subscription's used-up usage that resets at
 * a stated time (`provider-admission/usage-reset.ts`, the rule a worker's attempt ladder reads too) is waited out without
 * a question. Once the run has settled with the transcript still ending on the refusal (no failover moved the work to
 * another model, no queued input ran), one wall alarm on the provider admission clock is armed for the reset and the
 * owner is told when the session continues; at the alarm the session continues what the refusal stopped. A goal a usage or rate
 * limit stopped is resumed and continued; otherwise the stopped turn is continued from its transcript. Nothing is
 * continued when anything ran since the refusal (the owner's own words, a wake): the transcript's last message is then no
 * longer the refusal, and a goal no longer stopped is not resumed. A reset the recorded exhaustion moved later (another
 * process met the limit again) re-arms the alarm for it.
 *
 * A metered (API-key) model's refusal, one that states no reset, one whose reset is too near to be a usage reset, and a
 * rate limit the turn's own retry waits out (its stated delay within the retry's limit, whose backoff the owner may cancel)
 * arm nothing: those stop as before. A worker process's session arms nothing: its attempt ladder waits for it. The alarm
 * lives in this process; after a restart or a switch to the session (`restoreWait`) the wait is armed again from what the
 * session kept: a goal the limit stopped waits for the reset its stop recorded, otherwise a transcript still ending on the
 * refusal waits for the reset that refusal stated, counted from when it arrived; the owner is told when it continues, or
 * that it continues now. Its notices are held until the session has a listener. A Codex usage limit also says whether
 * the account holds a usage reset to redeem (`/usage`); a redeemed reset ends the wait at once.
 *
 * How each wait ended is recorded in the transcript (`usage-wake-record.ts`): resumed, failed, or declined by the owner's
 * stop. A stop a record answers is not waited out again, here or by a host reading the closed session; a continuation that
 * threw is tried again after a delay that grows with each failure in a row, up to a bound, never given up.
 */

import { type Api, type AssistantMessage, listOpenAICodexRateLimitResetCredits, type Model } from "@caupulican/pi-ai";
import { type ClassifiedError, classifyFailure } from "../kernel/reliability/index.ts";
import type { AgentMessage } from "../kernel/types.ts";
import type { GoalState, GoalStopModel } from "./goals/goal-state.ts";
import { interfaceText } from "./language/interface-text.ts";
import { usageResetWaitMs } from "./provider-admission/usage-reset.ts";
import {
	latestUsageWake,
	recordUsageWake,
	type UsageWakeLog,
	type UsageWakeRecord,
	type UsageWakeWriter,
	usageStopContinuesAt,
	usageWakeRetryDelayMs,
} from "./usage-wake-record.ts";
import { alarmAt, type TimerPort, type WallAlarm } from "./util/timer-port.ts";

/** The session's transcript: its messages, and the entries the wait's records are read from and written to. */
export interface UsageTranscript {
	readonly agent: { readonly state: { readonly messages: readonly AgentMessage[] } };
	readonly sessionManager: UsageWakeLog & UsageWakeWriter;
}

export interface UsageResetResumeDeps {
	/** False in a worker process's session, whose attempt ladder waits out its usage reset. */
	readonly enabled: boolean;
	/** The provider admission clock: the clock the recorded exhaustions are kept on. */
	readonly clock: TimerPort;
	readonly modelRegistry: {
		find(provider: string, modelId: string): Model<Api> | undefined;
		isUsingSubscription(model: Model<Api>): boolean;
		getApiKeyForProvider(provider: string): Promise<string | undefined>;
		readonly authStorage: {
			getOAuthRequestHeaders(provider: string, accessToken: string): Record<string, string> | undefined;
		};
	};
	/** The longest stated delay the turn's own retry waits out (`retry.provider.maxRetryDelayMs`). */
	inRunRetryMaxMs(): number;
	/** The quota exhaustion recorded for a model ref and its reset, when one holds. */
	modelExhaustion(ref: string): { readonly until: number | undefined } | undefined;
	readonly transcript: UsageTranscript;
	waitForIdle(): Promise<void>;
	isDisposed(): boolean;
	/** Resume the session's goal when a usage or rate limit stopped it; whether one was resumed (its continuation follows). */
	resumeUsageLimitedGoal(): boolean;
	/** Continue the stopped turn from its transcript, its trailing refusal dropped. */
	continueTurn(): Promise<void>;
	/** Tell the owner now, or hold the notice until the session has a listener. */
	warn(message: string): void;
}

/** The wait a restore found: when it ends, and whether it is a goal's that a usage or rate limit stopped. */
export interface RestoredUsageWait {
	readonly until: number;
	readonly goal: boolean;
}

interface PendingResume {
	readonly ref: string;
	readonly provider: string;
	/** The refusal that stopped the turn; absent for a goal's wait restored from its record, which resumes the goal only. */
	readonly refusal?: AssistantMessage;
	/** When the stop was made: a wake record at or after it answers it. */
	readonly stopAt: number;
	readonly at: number;
	readonly alarm: WallAlarm;
}

export class UsageResetResume {
	private pending: PendingResume | undefined;
	/** Counts the stops seen, so a stop settling after a newer one arms nothing. */
	private stops = 0;
	/** Providers whose redeemable usage resets the owner was told of; told again only after a redemption. */
	private readonly resetOffered = new Set<string>();
	private readonly resetChecking = new Set<string>();
	private readonly deps: UsageResetResumeDeps;

	constructor(deps: UsageResetResumeDeps) {
		this.deps = deps;
	}

	/** A run ended on a classified provider failure no retry took. */
	runStopped(message: AssistantMessage, classified: ClassifiedError): void {
		if (classified.reason === "billing_or_quota") void this.offerCodexReset(message);
		const stop = ++this.stops;
		const model = this.deps.modelRegistry.find(message.provider, message.model);
		const resetMs = model === undefined ? undefined : this.resetWaitMs(classified, model);
		if (resetMs !== undefined) void this.settle(stop, message, this.deps.clock.now() + resetMs);
	}

	/**
	 * After a restart or a switch to this session, the wait its stop would have armed, from what the session kept. A goal a
	 * usage or rate limit stopped waits for the reset its stop stated, read from the goal's own record (the stop's time, the
	 * refusal it kept and the model that refused, on a subscription). Otherwise a transcript ending on a refusal waits for
	 * the reset that refusal stated, counted from its arrival, and the turn is continued at the reset as when the stop armed
	 * it. The same rule decides both: a stop with no stated reset, a metered model's and a near reset arm nothing. A reset
	 * already passed continues at once. The owner is told which; the wait found, undefined when there is none.
	 */
	restoreWait(goal: GoalState | undefined): RestoredUsageWait | undefined {
		const goalStopped = goal !== undefined && goalUsageStop(goal) !== undefined;
		if (this.pending) return { until: this.pending.at, goal: goalStopped };
		const restored = this.restoredStop(goal);
		if (!restored) return undefined;
		this.arm(restored.resume, restored.at);
		const words = interfaceText().notices.usageReset;
		this.deps.warn(
			restored.at > this.deps.clock.now()
				? words.sessionWaits(new Date(restored.at).toISOString())
				: words.sessionContinuesNow(),
		);
		return { until: restored.at, goal: goalStopped };
	}

	/** The wait a kept stop calls for ({@link restoredUsageStop}); none in a worker process's session. */
	private restoredStop(goal: GoalState | undefined): RestoredUsageStop | undefined {
		if (!this.deps.enabled) return undefined;
		return restoredUsageStop(
			this.lastMessage(),
			goal,
			latestUsageWake(this.deps.transcript.sessionManager),
			this.deps,
		);
	}

	private lastMessage(): AgentMessage | undefined {
		return this.deps.transcript.agent.state.messages.at(-1);
	}

	/** The owner redeemed a usage reset for `provider`: a wait on it ends now, and a later limit is offered again. */
	noteUsageReset(provider: string): void {
		this.resetOffered.delete(provider);
		const pending = this.pending;
		if (pending?.provider === provider) this.arm(pending, this.deps.clock.now());
	}

	dispose(): void {
		this.pending?.alarm.stop();
		this.pending = undefined;
	}

	/** The usage reset a refusal on `model` is waited out for here ({@link usageResetWait}); none in a worker process's session. */
	private resetWaitMs(classified: ClassifiedError, model: Model<Api>): number | undefined {
		return this.deps.enabled ? usageResetWait(classified, model, this.deps) : undefined;
	}

	/** Arms the wait once the stopped run has settled and nothing moved the work on from the refusal. */
	private async settle(stop: number, refusal: AssistantMessage, at: number): Promise<void> {
		await this.deps.waitForIdle();
		if (stop !== this.stops || this.deps.isDisposed()) return;
		if (!isSameRefusal(this.lastMessage(), refusal)) return;
		const resume = { ref: `${refusal.provider}/${refusal.model}`, provider: refusal.provider, refusal };
		this.arm({ ...resume, stopAt: refusal.timestamp }, at);
		this.deps.warn(interfaceText().notices.usageReset.sessionWaits(new Date(at).toISOString()));
	}

	/**
	 * A wall alarm for `at`: it fires once the clock reads `at`, however far off (no platform timer limit) and however long
	 * the machine slept meanwhile.
	 */
	private arm(resume: Omit<PendingResume, "at" | "alarm">, at: number): void {
		this.pending?.alarm.stop();
		const { ref, provider, refusal, stopAt } = resume;
		const alarm = alarmAt(this.deps.clock, at, () => {
			this.wake().catch((error: unknown) => {
				const detail = error instanceof Error ? error.message : String(error);
				this.deps.warn(interfaceText().notices.usageReset.sessionWakeNotRecorded(detail));
			});
		});
		this.pending = { ref, provider, ...(refusal ? { refusal } : {}), stopAt, at, alarm };
	}

	private async wake(): Promise<void> {
		const pending = this.pending;
		this.pending = undefined;
		if (!pending || this.deps.isDisposed()) return;
		const until = this.deps.modelExhaustion(pending.ref)?.until;
		if (until !== undefined && until > this.deps.clock.now()) {
			this.arm(pending, until);
			return;
		}
		await this.deps.waitForIdle();
		// A newer refusal re-armed the wait, or the session closed, while the foreground finished.
		if (this.pending || this.deps.isDisposed()) return;
		const transcript = this.deps.transcript.sessionManager;
		const prior = latestUsageWake(transcript);
		// The owner's stop declined this wait after it was armed (a failed try of the same stop is retried).
		if (usageStopContinuesAt(pending.stopAt, pending.at, prior) === undefined) return;
		if (this.deps.resumeUsageLimitedGoal()) {
			recordUsageWake(transcript, "resumed", pending.stopAt, this.deps.clock.now(), 0);
			return;
		}
		if (!pending.refusal || !isSameRefusal(this.lastMessage(), pending.refusal)) return;
		let failure: { readonly error: unknown } | undefined;
		try {
			await this.deps.continueTurn();
		} catch (error) {
			failure = { error };
		}
		const now = this.deps.clock.now();
		if (!failure) {
			recordUsageWake(transcript, "resumed", pending.stopAt, now, 0);
			return;
		}
		const failures = prior?.outcome === "failed" && pending.stopAt <= prior.stopAt ? prior.failures + 1 : 1;
		const retryAt = now + usageWakeRetryDelayMs(failures);
		this.arm(pending, retryAt);
		const detail = failure.error instanceof Error ? failure.error.message : String(failure.error);
		this.deps.warn(interfaceText().notices.usageReset.sessionResumeFailed(detail, new Date(retryAt).toISOString()));
		recordUsageWake(transcript, "failed", pending.stopAt, now, failures);
	}

	/**
	 * Codex answered that the subscription's usage limit is reached: say whether the account holds a usage reset it can
	 * redeem (`/usage`); once told, not again this session until a reset is redeemed. Only a notice the owner received
	 * uses up the episode; a check that found no reset or could not complete is made again on the next limit answer.
	 */
	private async offerCodexReset(message: AssistantMessage): Promise<void> {
		const provider = message.provider;
		if (provider !== "openai-codex" || this.resetOffered.has(provider) || this.resetChecking.has(provider)) return;
		this.resetChecking.add(provider);
		const codex = this.deps.modelRegistry.find(message.provider, message.model);
		try {
			const accessToken = await this.deps.modelRegistry.getApiKeyForProvider(message.provider);
			if (!accessToken) return;
			const summary = await listOpenAICodexRateLimitResetCredits({
				accessToken,
				credentialHeaders: this.deps.modelRegistry.authStorage.getOAuthRequestHeaders(
					message.provider,
					accessToken,
				),
				baseUrl: codex?.baseUrl,
				signal: AbortSignal.timeout(15_000),
			});
			if (summary.availableCount === 0) return;
			this.resetOffered.add(provider);
			this.deps.warn(interfaceText().notices.usageReset.codexResetsAvailable(summary.availableCount));
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.deps.warn(interfaceText().notices.usageReset.codexResetCheckFailed(detail));
		} finally {
			this.resetChecking.delete(provider);
		}
	}
}

/** What the rule of a kept stop reads: the refusing model, whether it runs on a subscription, and the in-run retry's bound. */
export interface RestoredUsageRules {
	readonly modelRegistry: Pick<UsageResetResumeDeps["modelRegistry"], "find" | "isUsingSubscription">;
	/** The longest stated delay the turn's own retry waits out (`retry.provider.maxRetryDelayMs`). */
	inRunRetryMaxMs(): number;
}

/**
 * A kept stop's wait: what continues at its end (the model's ref, its provider, the refusal the turn stopped on and when the
 * stop was made), and when.
 */
export interface RestoredUsageStop {
	readonly resume: {
		readonly ref: string;
		readonly provider: string;
		readonly refusal?: AssistantMessage;
		readonly stopAt: number;
	};
	readonly at: number;
}

/**
 * The wait a kept stop calls for, read from what a session keeps (no alarm, no clock): the goal's recorded stop first,
 * classified against the model whose refusal it recorded (a stop recorded without one is read from the transcript
 * instead), else the refusal `lastMessage`, the transcript's last message, is. The same rule as a live stop's
 * ({@link usageResetWait}); undefined when it calls for none. A reset the provider admission recorded later is not folded in.
 * `wake`, the session's latest wake record, answers a stop made at or before the one it names: resumed or declined, it calls for no
 * wait; failed, for the next try (`usageStopContinuesAt`).
 */
export function restoredUsageStop(
	lastMessage: AgentMessage | undefined,
	goal: GoalState | undefined,
	wake: UsageWakeRecord | undefined,
	rules: RestoredUsageRules,
): RestoredUsageStop | undefined {
	const kept = keptUsageStop(lastMessage, goal, rules);
	if (!kept) return undefined;
	const at = usageStopContinuesAt(kept.resume.stopAt, kept.at, wake);
	return at === undefined ? undefined : { resume: kept.resume, at };
}

function keptUsageStop(
	lastMessage: AgentMessage | undefined,
	goal: GoalState | undefined,
	rules: RestoredUsageRules,
): RestoredUsageStop | undefined {
	const stop = goal ? goalUsageStop(goal) : undefined;
	const model = stop?.refusedBy && rules.modelRegistry.find(stop.refusedBy.provider, stop.refusedBy.id);
	if (stop && model) {
		const resetMs = usageResetWait(
			classifyFailure({ message: stop.refusal, provider: model.provider }),
			model,
			rules,
		);
		if (resetMs !== undefined)
			return {
				resume: { ref: `${model.provider}/${model.id}`, provider: model.provider, stopAt: stop.at },
				at: stop.at + resetMs,
			};
	}
	const refusal = lastMessage;
	if (refusal?.role !== "assistant" || refusal.stopReason !== "error" || !refusal.errorMessage) return undefined;
	const refusalModel = rules.modelRegistry.find(refusal.provider, refusal.model);
	if (!refusalModel) return undefined;
	const resetMs = usageResetWait(
		classifyFailure({ message: refusal.errorMessage, provider: refusal.provider }),
		refusalModel,
		rules,
	);
	if (resetMs === undefined) return undefined;
	const resume = {
		ref: `${refusal.provider}/${refusal.model}`,
		provider: refusal.provider,
		refusal,
		stopAt: refusal.timestamp,
	};
	return { resume, at: refusal.timestamp + resetMs };
}

/** The usage reset a refusal on `model` is waited out for; a rate limit the turn's own retry waits out is not. */
function usageResetWait(classified: ClassifiedError, model: Model<Api>, rules: RestoredUsageRules): number | undefined {
	const resetMs = usageResetWaitMs(classified, rules.modelRegistry.isUsingSubscription(model));
	if (resetMs === undefined) return undefined;
	return classified.reason === "rate_limit" && resetMs <= rules.inRunRetryMaxMs() ? undefined : resetMs;
}

/** The transcript still ends on the refusal: nothing ran after it. */
function isSameRefusal(last: AgentMessage | undefined, refusal: AssistantMessage): boolean {
	if (last === refusal) return true;
	return (
		last?.role === "assistant" &&
		last.stopReason === refusal.stopReason &&
		last.timestamp === refusal.timestamp &&
		last.errorMessage === refusal.errorMessage
	);
}

/**
 * The usage or rate limit that stopped `goal`, from its own record: the refusal its stop kept, when it stopped and the
 * model that refused (the latest system stop in its event history; a stop recorded before the model was kept names none);
 * undefined when another stop holds it or the stop is no longer in its history.
 */
function goalUsageStop(
	goal: GoalState,
): { readonly refusal: string; readonly at: number; readonly refusedBy?: GoalStopModel } | undefined {
	const prefix =
		goal.status === "usage_limited" ? "billing_or_quota: " : goal.status === "blocked" ? "rate_limit: " : undefined;
	if (prefix === undefined || !goal.blockedReason?.startsWith(prefix)) return undefined;
	for (let index = goal.events.length - 1; index >= 0; index--) {
		const event = goal.events[index];
		if (event?.type !== "system_stop_goal") continue;
		const at = Date.parse(event.now);
		return event.status === goal.status && event.reason === goal.blockedReason && Number.isFinite(at)
			? {
					refusal: goal.blockedReason.slice(prefix.length),
					at,
					...(event.refusedBy ? { refusedBy: event.refusedBy } : {}),
				}
			: undefined;
	}
	return undefined;
}

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
 */

import { type Api, type AssistantMessage, listOpenAICodexRateLimitResetCredits, type Model } from "@caupulican/pi-ai";
import { type ClassifiedError, classifyFailure } from "../kernel/reliability/index.ts";
import type { AgentMessage } from "../kernel/types.ts";
import type { GoalState, GoalStopModel } from "./goals/goal-state.ts";
import { interfaceText } from "./language/interface-text.ts";
import { usageResetWaitMs } from "./provider-admission/usage-reset.ts";
import { alarmAt, type TimerPort, type WallAlarm } from "./util/timer-port.ts";

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
	/** The last message of the session's transcript. */
	lastMessage(): AgentMessage | undefined;
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

	/**
	 * The wait a kept stop calls for: the goal's recorded stop first, classified against the model whose refusal it
	 * recorded (a stop recorded without one is read from the transcript instead), else the refusal the transcript ends on.
	 */
	private restoredStop(
		goal: GoalState | undefined,
	): { readonly resume: Omit<PendingResume, "at" | "alarm">; readonly at: number } | undefined {
		const stop = goal ? goalUsageStop(goal) : undefined;
		const model = stop?.refusedBy && this.deps.modelRegistry.find(stop.refusedBy.provider, stop.refusedBy.id);
		if (stop && model) {
			const resetMs = this.resetWaitMs(classifyFailure({ message: stop.refusal, provider: model.provider }), model);
			if (resetMs !== undefined)
				return {
					resume: { ref: `${model.provider}/${model.id}`, provider: model.provider },
					at: stop.at + resetMs,
				};
		}
		const refusal = this.deps.lastMessage();
		if (refusal?.role !== "assistant" || refusal.stopReason !== "error" || !refusal.errorMessage) return undefined;
		const refusalModel = this.deps.modelRegistry.find(refusal.provider, refusal.model);
		if (!refusalModel) return undefined;
		const classified = classifyFailure({ message: refusal.errorMessage, provider: refusal.provider });
		const resetMs = this.resetWaitMs(classified, refusalModel);
		if (resetMs === undefined) return undefined;
		const resume = { ref: `${refusal.provider}/${refusal.model}`, provider: refusal.provider, refusal };
		return { resume, at: refusal.timestamp + resetMs };
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

	/** The usage reset a refusal on `model` is waited out for here; a rate limit the turn's own retry waits out is not. */
	private resetWaitMs(classified: ClassifiedError, model: Model<Api>): number | undefined {
		if (!this.deps.enabled) return undefined;
		const resetMs = usageResetWaitMs(classified, this.deps.modelRegistry.isUsingSubscription(model));
		if (resetMs === undefined) return undefined;
		return classified.reason === "rate_limit" && resetMs <= this.deps.inRunRetryMaxMs() ? undefined : resetMs;
	}

	/** Arms the wait once the stopped run has settled and nothing moved the work on from the refusal. */
	private async settle(stop: number, refusal: AssistantMessage, at: number): Promise<void> {
		await this.deps.waitForIdle();
		if (stop !== this.stops || this.deps.isDisposed()) return;
		if (!isSameRefusal(this.deps.lastMessage(), refusal)) return;
		this.arm({ ref: `${refusal.provider}/${refusal.model}`, provider: refusal.provider, refusal }, at);
		this.deps.warn(interfaceText().notices.usageReset.sessionWaits(new Date(at).toISOString()));
	}

	/**
	 * A wall alarm for `at`: it fires once the clock reads `at`, however far off (no platform timer limit) and however long
	 * the machine slept meanwhile.
	 */
	private arm(resume: Omit<PendingResume, "at" | "alarm">, at: number): void {
		this.pending?.alarm.stop();
		const { ref, provider, refusal } = resume;
		const alarm = alarmAt(this.deps.clock, at, () => void this.wake());
		this.pending = { ref, provider, ...(refusal ? { refusal } : {}), at, alarm };
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
		if (this.deps.resumeUsageLimitedGoal()) return;
		if (!pending.refusal || !isSameRefusal(this.deps.lastMessage(), pending.refusal)) return;
		try {
			await this.deps.continueTurn();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.deps.warn(interfaceText().notices.usageReset.sessionResumeFailed(detail));
		}
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

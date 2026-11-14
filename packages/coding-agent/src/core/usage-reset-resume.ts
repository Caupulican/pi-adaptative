/**
 * What a root session does when a run ends on its provider's usage limit. A subscription's used-up usage that resets at
 * a stated time (`provider-admission/usage-reset.ts`, the rule a worker's attempt ladder reads too) is waited out without
 * a question. Once the run has settled with the transcript still ending on the refusal (no failover moved the work to
 * another model, no queued input ran), one alarm on the provider admission clock is armed for the reset and the owner is
 * told when the session continues; at the alarm the session continues what the refusal stopped. A goal a usage or rate
 * limit stopped is resumed and continued; otherwise the stopped turn is continued from its transcript. Nothing is
 * continued when anything ran since the refusal (the owner's own words, a wake): the transcript's last message is then no
 * longer the refusal, and a goal no longer stopped is not resumed. A reset the recorded exhaustion moved later (another
 * process met the limit again) re-arms the alarm for it.
 *
 * A metered (API-key) model's refusal, one that states no reset, one whose reset is too near to be a usage reset, and a
 * rate limit the turn's own retry waits out (its stated delay within the retry's limit, whose backoff the owner may cancel)
 * arm nothing: those stop as before. A worker process's session arms nothing: its attempt ladder waits for it. The alarm
 * lives in this process; after a restart a goal the limit stopped waits again for the reset its stop recorded
 * (`restoreGoalWait`), and a plain stopped turn is left for the owner. A Codex usage limit also says whether the account
 * holds a usage reset to redeem (`/usage`); a redeemed reset ends the wait at once.
 */

import { type Api, type AssistantMessage, listOpenAICodexRateLimitResetCredits, type Model } from "@caupulican/pi-ai";
import { type ClassifiedError, classifyFailure } from "../kernel/reliability/index.ts";
import type { AgentMessage } from "../kernel/types.ts";
import type { AgentSessionEvent } from "./agent-session-contracts.ts";
import type { GoalState } from "./goals/goal-state.ts";
import { interfaceText } from "./language/interface-text.ts";
import { usageResetWaitMs } from "./provider-admission/usage-reset.ts";
import type { TimerPort } from "./util/timer-port.ts";

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
	emit(event: AgentSessionEvent): void;
}

interface PendingResume {
	readonly ref: string;
	readonly provider: string;
	/** The refusal that stopped the turn; absent for a goal's wait restored from its record, which resumes the goal only. */
	readonly refusal?: AssistantMessage;
	readonly handle: unknown;
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
	 * After a restart or a switch to this session: a goal a usage or rate limit stopped waits for the reset its stop stated,
	 * read from the goal's own record (the stop's time and the refusal it kept), when it runs on a subscription `model`; a
	 * reset already passed resumes it at once. A stop that states no reset is left for the owner.
	 */
	restoreGoalWait(goal: GoalState | undefined, model: Model<Api> | undefined): void {
		const stop = goal && model ? goalUsageStop(goal) : undefined;
		if (!stop || !model || this.pending) return;
		const resetMs = this.resetWaitMs(classifyFailure({ message: stop.refusal, provider: model.provider }), model);
		if (resetMs === undefined) return;
		this.arm({ ref: `${model.provider}/${model.id}`, provider: model.provider }, stop.at + resetMs);
	}

	/** The owner redeemed a usage reset for `provider`: a wait on it ends now, and a later limit is offered again. */
	noteUsageReset(provider: string): void {
		this.resetOffered.delete(provider);
		const pending = this.pending;
		if (pending?.provider === provider) this.arm(pending, this.deps.clock.now());
	}

	dispose(): void {
		if (this.pending) this.deps.clock.clearTimeout(this.pending.handle);
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
		this.deps.emit({
			type: "warning",
			message: interfaceText().notices.usageReset.sessionWaits(new Date(at).toISOString()),
		});
	}

	private arm(resume: Omit<PendingResume, "handle">, at: number): void {
		if (this.pending) this.deps.clock.clearTimeout(this.pending.handle);
		const handle = this.deps.clock.setTimeout(() => void this.wake(), Math.max(0, at - this.deps.clock.now()));
		this.pending = { ...resume, handle };
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
			this.deps.emit({
				type: "warning",
				message: interfaceText().notices.usageReset.sessionResumeFailed(
					error instanceof Error ? error.message : String(error),
				),
			});
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
			this.deps.emit({
				type: "warning",
				message: `OpenAI Codex usage limit reached. ${summary.availableCount} usage ${summary.availableCount === 1 ? "reset is" : "resets are"} available: /usage, then Redeem usage limit reset.`,
			});
		} catch (error) {
			this.deps.emit({
				type: "warning",
				message: `OpenAI Codex usage limit reached; checking for usage resets failed: ${error instanceof Error ? error.message : String(error)}`,
			});
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
 * The usage or rate limit that stopped `goal`, from its own record: the refusal its stop kept and when it stopped (the
 * latest system stop in its event history); undefined when another stop holds it or the stop is no longer in its history.
 */
function goalUsageStop(goal: GoalState): { readonly refusal: string; readonly at: number } | undefined {
	const prefix =
		goal.status === "usage_limited" ? "billing_or_quota: " : goal.status === "blocked" ? "rate_limit: " : undefined;
	if (prefix === undefined || !goal.blockedReason?.startsWith(prefix)) return undefined;
	for (let index = goal.events.length - 1; index >= 0; index--) {
		const event = goal.events[index];
		if (event?.type !== "system_stop_goal") continue;
		const at = Date.parse(event.now);
		return event.status === goal.status && event.reason === goal.blockedReason && Number.isFinite(at)
			? { refusal: goal.blockedReason.slice(prefix.length), at }
			: undefined;
	}
	return undefined;
}

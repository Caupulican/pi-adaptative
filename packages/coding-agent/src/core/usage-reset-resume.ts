/**
 * What a root session does when a run ends on its provider's usage limit. A subscription's used-up usage that resets at
 * a stated time (`provider-admission/usage-reset.ts`, the rule a worker's attempt ladder reads too) is waited out without
 * a question: one alarm on the provider admission clock is armed for the reset, the owner is told when the session
 * continues, and at the alarm the session continues what the refusal stopped. A goal the refusal left usage-limited is
 * resumed and continued; otherwise the stopped turn is continued from its transcript. Nothing is continued when anything
 * ran since the refusal (the owner's own words, a wake, a failover that moved the work to another model): the
 * transcript's last message is then no longer the refusal, and a goal no longer usage-limited is not resumed. A reset the
 * recorded exhaustion moved later (another process met the limit again) re-arms the alarm for it.
 *
 * A metered (API-key) model's refusal, one that states no reset and one whose reset is too near to be a usage reset arm
 * nothing: those stop as before. The alarm lives in this process; a restart leaves the stopped turn for the owner.
 * A Codex usage limit also says whether the account holds a usage reset to redeem (`/usage`); a redeemed reset ends the
 * wait at once.
 */

import { type Api, type AssistantMessage, listOpenAICodexRateLimitResetCredits, type Model } from "@caupulican/pi-ai";
import type { ClassifiedError } from "../kernel/reliability/index.ts";
import type { AgentMessage } from "../kernel/types.ts";
import type { AgentSessionEvent } from "./agent-session-contracts.ts";
import { interfaceText } from "./language/interface-text.ts";
import { usageResetWaitMs } from "./provider-admission/usage-reset.ts";
import type { TimerPort } from "./util/timer-port.ts";

export interface UsageResetResumeDeps {
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
	/** The quota exhaustion recorded for a model ref and its reset, when one holds. */
	modelExhaustion(ref: string): { readonly until: number | undefined } | undefined;
	/** The last message of the session's transcript. */
	lastMessage(): AgentMessage | undefined;
	waitForIdle(): Promise<void>;
	isDisposed(): boolean;
	/** Resume the session's goal when the usage limit stopped it; whether one was resumed (its continuation follows). */
	resumeUsageLimitedGoal(): boolean;
	/** Continue the stopped turn from its transcript, its trailing refusal dropped. */
	continueTurn(): Promise<void>;
	emit(event: AgentSessionEvent): void;
}

interface PendingResume {
	readonly ref: string;
	readonly provider: string;
	readonly refusal: AssistantMessage;
	readonly handle: unknown;
}

export class UsageResetResume {
	private pending: PendingResume | undefined;
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
		const model = this.deps.modelRegistry.find(message.provider, message.model);
		const resetMs = model
			? usageResetWaitMs(classified, this.deps.modelRegistry.isUsingSubscription(model))
			: undefined;
		if (resetMs === undefined) return;
		const at = this.deps.clock.now() + resetMs;
		this.arm({ ref: `${message.provider}/${message.model}`, provider: message.provider, refusal: message }, at);
		this.deps.emit({
			type: "warning",
			message: interfaceText().notices.usageReset.sessionWaits(new Date(at).toISOString()),
		});
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
		if (!isSameRefusal(this.deps.lastMessage(), pending.refusal)) return;
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

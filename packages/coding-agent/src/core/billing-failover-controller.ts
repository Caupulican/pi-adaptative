import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@caupulican/pi-agent-core/agent";
import { type ClassifiedError, classifyFailure } from "@caupulican/pi-agent-core/reliability";
import type { Api, AssistantMessage, Model } from "@caupulican/pi-ai";
import { decideBillingFailover } from "./billing-failover.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { ModelRouterFailoverStatus } from "./model-router/status.ts";
import { writeFileAtomicSync } from "./util/atomic-file.ts";

const DEFAULT_MODEL_PER_PROVIDER: Record<string, string> = {
	"openai-codex": "gpt-5.6-sol",
};

/**
 * Which identity an exhaustion invalidates: one model deployment (`model`, the default) or every
 * model reached through the provider's credential (`provider`, recorded as `<provider>/*`).
 */
export type ExhaustionScope = "model" | "provider";

/**
 * Models and providers known to be exhausted (billing or quota). With a `storeDir` the registry is
 * also file-backed under `state/provider-admission/exhausted/`, so every pi process on the machine
 * shares what one of them learned instead of each rediscovering it against the same account. An
 * entry without an expiry lasts for the process that recorded it and is not shared.
 */
export class ExhaustedProviderRegistry {
	private readonly exhausted = new Map<string, number | undefined>();
	private readonly storeDir: string | undefined;

	constructor(storeDir?: string) {
		this.storeDir = storeDir;
	}

	markExhausted(ref: string, until?: number, scope: ExhaustionScope = "model"): void {
		const key = scope === "provider" ? `${ref.split("/")[0]}/*` : ref;
		this.exhausted.set(key, until);
		if (this.storeDir && until !== undefined) {
			try {
				mkdirSync(this.storeDir, { recursive: true });
				writeFileAtomicSync(
					this.storePath(key),
					`${JSON.stringify({ ref: key, until, pid: process.pid, recordedAt: Date.now() })}\n`,
					{ mode: 0o600 },
				);
			} catch {
				// A failed share leaves the process-local record intact.
			}
		}
	}

	isExhausted(ref: string): boolean {
		const providerWide = `${ref.split("/")[0]}/*`;
		return this.isExhaustedKey(ref) || (ref !== providerWide && this.isExhaustedKey(providerWide));
	}

	private isExhaustedKey(key: string): boolean {
		if (this.exhausted.has(key)) {
			const until = this.exhausted.get(key);
			if (until === undefined || Date.now() < until) return true;
			this.exhausted.delete(key);
		}
		const shared = this.readShared(key);
		if (shared === undefined) return false;
		if (Date.now() < shared) {
			this.exhausted.set(key, shared);
			return true;
		}
		rmSync(this.storePath(key), { force: true });
		return false;
	}

	private storePath(key: string): string {
		return join(this.storeDir ?? "", `${key.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
	}

	private readShared(key: string): number | undefined {
		if (!this.storeDir) return undefined;
		try {
			const parsed = JSON.parse(readFileSync(this.storePath(key), "utf-8")) as { until?: unknown };
			return typeof parsed.until === "number" && Number.isFinite(parsed.until) ? parsed.until : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Forget every exhaustion recorded for a provider (its models and its provider-wide entry), in
	 * this process and the shared store: the account's limits were reset, so none of them holds.
	 */
	clearProvider(provider: string): void {
		const matches = (key: string) => key.split("/")[0] === provider;
		for (const key of [...this.exhausted.keys()]) if (matches(key)) this.exhausted.delete(key);
		if (!this.storeDir || !existsSync(this.storeDir)) return;
		for (const name of readdirSync(this.storeDir)) {
			if (!name.endsWith(".json")) continue;
			try {
				const parsed = JSON.parse(readFileSync(join(this.storeDir, name), "utf-8")) as { ref?: unknown };
				if (typeof parsed.ref === "string" && matches(parsed.ref))
					rmSync(join(this.storeDir, name), { force: true });
			} catch {
				// A half-written entry names nothing yet.
			}
		}
	}

	snapshot(): string[] {
		const keys = new Set(this.exhausted.keys());
		if (this.storeDir && existsSync(this.storeDir)) {
			for (const name of readdirSync(this.storeDir)) {
				if (!name.endsWith(".json")) continue;
				try {
					const parsed = JSON.parse(readFileSync(join(this.storeDir, name), "utf-8")) as { ref?: unknown };
					if (typeof parsed.ref === "string") keys.add(parsed.ref);
				} catch {
					// Skip a half-written entry.
				}
			}
		}
		return [...keys].filter((key) => this.isExhaustedKey(key)).sort();
	}
}

export interface BillingFailoverControllerDeps {
	agent: Agent;
	/**
	 * Moves work off the exhausted model: a routed turn's model inside that turn, otherwise the session
	 * model, recorded like any other session model change. A routed turn's model is never the session's.
	 * Returns the model the work actually continues on, or undefined when nothing could take it.
	 */
	applyFailoverModel(failed: Model<Api>, hop: Model<Api>): Model<Api> | undefined;
	/** The router's usable model for the work when there is no same-provider hop (see `BillingFailoverInput.fallback`). */
	resolveFallbackModel?(failed: Model<Api>): Model<Api> | undefined;
	modelRegistry: ModelRegistry;
	emit(event: { type: "warning"; message: string }): void;
	exhausted: ExhaustedProviderRegistry;
	subscriptionHop?: boolean;
	recordFailure?(args: {
		provider?: string;
		modelId?: string;
		message: string;
		classified: ReturnType<typeof classifyFailure>;
	}): void;
}

/** Whether a billing/quota failure was handled, and where the work continues when it moved to another model. */
export interface BillingFailoverOutcome {
	handled: boolean;
	continuedOn?: string;
}

export class BillingFailoverController {
	private readonly deps: BillingFailoverControllerDeps;
	private lastNotice: string | undefined;

	constructor(deps: BillingFailoverControllerDeps) {
		this.deps = deps;
	}

	isExhausted(ref: string): boolean {
		return this.deps.exhausted.isExhausted(ref);
	}

	clearProviderExhaustion(provider: string): void {
		this.deps.exhausted.clearProvider(provider);
	}

	snapshotExhausted(): string[] {
		return this.deps.exhausted.snapshot();
	}

	getLastNotice(): string | undefined {
		return this.lastNotice;
	}

	getStatus(): ModelRouterFailoverStatus {
		return { exhausted: this.snapshotExhausted(), lastNotice: this.lastNotice };
	}

	async handleAssistantError(
		message: AssistantMessage,
		classified?: ClassifiedError,
	): Promise<BillingFailoverOutcome> {
		if (message.stopReason !== "error") return { handled: false };
		classified ??= classifyFailure({ message: message.errorMessage ?? "", provider: message.provider });
		if (classified.reason !== "billing_or_quota") return { handled: false };
		const failedModel = this.deps.modelRegistry.find(message.provider, message.model) ?? this.deps.agent.state.model;
		const failedRef = `${failedModel.provider}/${failedModel.id}`;
		this.deps.exhausted.markExhausted(failedRef, expiryFromRetryAfter(classified.retryAfterMs));

		const defaultModelId = DEFAULT_MODEL_PER_PROVIDER[failedModel.provider];
		const hop = defaultModelId ? this.deps.modelRegistry.find(failedModel.provider, defaultModelId) : undefined;
		// Resolved after the failed model is marked exhausted, so the router never hands it back.
		const fallback = this.deps.resolveFallbackModel?.(failedModel);
		const action = decideBillingFailover({
			failedModel: { provider: failedModel.provider, id: failedModel.id },
			billingClass: this.deps.modelRegistry.isUsingSubscription(failedModel) ? "subscription" : "metered",
			providerDefaultModelId: defaultModelId,
			hopResolvesWithAuth: Boolean(hop && this.deps.modelRegistry.hasConfiguredAuth(hop)),
			hopExhausted: hop ? this.deps.exhausted.isExhausted(`${hop.provider}/${hop.id}`) : false,
			subscriptionHop: this.deps.subscriptionHop,
			...(fallback ? { fallback: { provider: fallback.provider, modelId: fallback.id } } : {}),
		});
		let continuedOn: Model<Api> | undefined;
		if (action.action === "failover") {
			const target = hop && action.to.provider === hop.provider && action.to.modelId === hop.id ? hop : fallback;
			continuedOn = target ? this.deps.applyFailoverModel(failedModel, target) : undefined;
		}
		// The notice names where the work actually continues: inside a routed turn that is the turn's own
		// replacement, not necessarily the model the decision proposed.
		const notice = continuedOn
			? `${failedModel.id} quota reached — continuing on ${continuedOn.provider}/${continuedOn.id}`
			: action.notice;
		this.lastNotice = notice;
		this.deps.emit({ type: "warning", message: notice });
		return continuedOn
			? { handled: true, continuedOn: `${continuedOn.provider}/${continuedOn.id}` }
			: { handled: true };
	}
}

function expiryFromRetryAfter(retryAfterMs: number | undefined): number | undefined {
	return retryAfterMs === undefined ? undefined : Date.now() + retryAfterMs;
}

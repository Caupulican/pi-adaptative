/**
 * Which models the owner's accounts can actually use, asked of the providers themselves before a
 * model is routed to. A stored credential says only that a key exists; a ChatGPT account refuses
 * Codex models that are not on its plan, and a revoked OpenRouter key refuses everything. Both are
 * facts about the account, so they are checked here and never discovered by a failed turn when
 * the provider can say so up front.
 *
 * A provider with no account listing (or one whose check could not complete) stays `unknown`, which
 * routing treats as usable: an unanswered check is reported in status, and a refusal from the
 * provider still marks the model through {@link AccountModelCatalog.markRefused}.
 */

import {
	type Api,
	listOpenAICodexAccountModels,
	type Model,
	OPENAI_CODEX_CLIENT_VERSION,
	type OpenAICodexAccountModel,
} from "@caupulican/pi-ai";
import type { RequestAuth } from "../request-auth.ts";

export type AccountModelAvailability = "available" | "unavailable" | "unknown";

/** What a provider's account check found. */
export type ProviderAccountState =
	| { readonly kind: "listed"; readonly models: ReadonlyMap<string, OpenAICodexAccountModel> }
	| { readonly kind: "key_valid" }
	| { readonly kind: "rejected"; readonly reason: string }
	| { readonly kind: "unchecked"; readonly reason: string };

export interface AccountModelCatalogDeps {
	/** Every model the registry knows. */
	getModels(): readonly Model<Api>[];
	hasConfiguredAuth(model: Model<Api>): boolean;
	/** The request credential for a model (an OAuth access token or API key). */
	getRequestAuth(model: Model<Api>): Promise<RequestAuth | undefined>;
	fetch?: typeof fetch;
}

const ACCOUNT_CHECK_TIMEOUT_MS = 10_000;
const MAX_REASON_CHARS = 200;

function bounded(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= MAX_REASON_CHARS ? flat : `${flat.slice(0, MAX_REASON_CHARS - 1)}…`;
}

function errorText(error: unknown): string {
	return bounded(error instanceof Error ? error.message : String(error));
}

/** The providers that answer "which models may this account use", and how each is asked. */
const ACCOUNT_CHECKS: Readonly<
	Record<
		string,
		(
			model: Model<Api>,
			apiKey: string,
			fetchImpl: typeof fetch,
			credentialHeaders: Record<string, string> | undefined,
		) => Promise<ProviderAccountState>
	>
> = {
	"openai-codex": async (model, apiKey, fetchImpl, credentialHeaders) => {
		const listed = await listOpenAICodexAccountModels({
			accessToken: apiKey,
			credentialHeaders,
			baseUrl: model.baseUrl,
			clientVersion: OPENAI_CODEX_CLIENT_VERSION,
			fetch: fetchImpl,
			signal: AbortSignal.timeout(ACCOUNT_CHECK_TIMEOUT_MS),
		});
		return { kind: "listed", models: new Map(listed.map((entry) => [entry.slug, entry])) };
	},
	openrouter: async (model, apiKey, fetchImpl) => {
		const response = await fetchImpl(`${model.baseUrl.replace(/\/+$/, "")}/key`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(ACCOUNT_CHECK_TIMEOUT_MS),
		});
		if (response.status === 401 || response.status === 403) {
			return { kind: "rejected", reason: `OpenRouter rejected the key (${response.status})` };
		}
		if (!response.ok) return { kind: "unchecked", reason: `OpenRouter key check returned ${response.status}` };
		return { kind: "key_valid" };
	},
};

export class AccountModelCatalog {
	private readonly deps: AccountModelCatalogDeps;
	private states = new Map<string, ProviderAccountState>();
	/** Models a provider refused for this account at request time, with the provider's words. */
	private readonly refused = new Map<string, string>();
	private pending: Promise<void> | undefined;
	private refreshGeneration = 0;

	constructor(deps: AccountModelCatalogDeps) {
		this.deps = deps;
	}

	/** Ask every provider that can answer, for the accounts that have a credential. */
	refresh(): Promise<void> {
		const generation = ++this.refreshGeneration;
		const run = this.checkAll().then((states) => {
			if (generation === this.refreshGeneration) this.states = states;
		});
		this.pending = run;
		return run;
	}

	/** Refresh account-derived availability only when this catalog owns that provider. */
	async refreshAfterAuthChange(provider: string): Promise<void> {
		if (!(provider in ACCOUNT_CHECKS)) return;
		await this.refresh();
	}

	/** Resolves once the latest check has settled (immediately when none was started). */
	/**
	 * Settles when every account check has, or when `signal` aborts first: a submission the owner
	 * interrupted does not keep waiting on an account check (a credential refresh can stall).
	 */
	async ready(signal?: AbortSignal): Promise<void> {
		if (!signal) {
			await this.pending;
			return;
		}
		if (signal.aborted) return;
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<void>((resolve) => {
			onAbort = () => resolve();
			signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			await Promise.race([this.pending, aborted]);
		} finally {
			if (onAbort) signal.removeEventListener("abort", onAbort);
		}
	}

	private async checkAll(): Promise<Map<string, ProviderAccountState>> {
		const fetchImpl = this.deps.fetch ?? globalThis.fetch;
		const representatives = new Map<string, Model<Api>>();
		const states = new Map<string, ProviderAccountState>();
		for (const model of this.deps.getModels()) {
			if (!(model.provider in ACCOUNT_CHECKS) || representatives.has(model.provider)) continue;
			if (this.deps.hasConfiguredAuth(model)) representatives.set(model.provider, model);
		}
		await Promise.all(
			[...representatives].map(async ([provider, model]) => {
				states.set(provider, await this.checkProvider(model, fetchImpl));
			}),
		);
		return states;
	}

	private async checkProvider(model: Model<Api>, fetchImpl: typeof fetch): Promise<ProviderAccountState> {
		try {
			const auth = await this.deps.getRequestAuth(model);
			if (!auth?.apiKey) return { kind: "unchecked", reason: "no credential resolved" };
			return await ACCOUNT_CHECKS[model.provider]!(model, auth.apiKey, fetchImpl, auth.credentialHeaders);
		} catch (error) {
			return { kind: "unchecked", reason: errorText(error) };
		}
	}

	availability(model: Model<Api>): AccountModelAvailability {
		if (this.refused.has(`${model.provider}/${model.id}`)) return "unavailable";
		const state = this.states.get(model.provider);
		if (!state || state.kind === "unchecked") return "unknown";
		if (state.kind === "rejected") return "unavailable";
		if (state.kind === "key_valid") return "available";
		return state.models.has(model.id) ? "available" : "unavailable";
	}

	/** Why a model is unavailable on this account, for status and skip reasons. */
	unavailableReason(model: Model<Api>): string | undefined {
		const refusal = this.refused.get(`${model.provider}/${model.id}`);
		if (refusal) return `refused by ${model.provider}: ${refusal}`;
		const state = this.states.get(model.provider);
		if (state?.kind === "rejected") return state.reason;
		if (state?.kind === "listed" && !state.models.has(model.id))
			return `not offered to this ${model.provider} account`;
		return undefined;
	}

	/** A provider refused this model for the account: never route to it again this session. */
	markRefused(model: Model<Api>, providerMessage: string): void {
		this.refused.set(`${model.provider}/${model.id}`, bounded(providerMessage));
	}

	/**
	 * The provider's own default for this account: its first offered model (by the provider's
	 * priority) that pi knows, has a credential for, and that was not refused.
	 */
	accountDefault(provider: string): Model<Api> | undefined {
		const state = this.states.get(provider);
		if (state?.kind !== "listed") return undefined;
		const known = new Map(
			this.deps
				.getModels()
				.filter((model) => model.provider === provider)
				.map((model) => [model.id, model]),
		);
		return [...state.models.values()]
			.filter((entry) => entry.visibility === "list")
			.sort((a, b) => a.priority - b.priority)
			.map((entry) => known.get(entry.slug))
			.find(
				(model): model is Model<Api> =>
					model !== undefined && this.deps.hasConfiguredAuth(model) && this.availability(model) !== "unavailable",
			);
	}

	/** One line per checked provider, for router status. */
	describe(): string[] {
		const lines: string[] = [];
		for (const [provider, state] of [...this.states].sort(([a], [b]) => a.localeCompare(b))) {
			if (state.kind === "listed") {
				const offered = [...state.models.values()]
					.filter((entry) => entry.visibility === "list")
					.sort((a, b) => a.priority - b.priority)
					.map((entry) => entry.slug);
				lines.push(`${provider}: ${offered.join(", ") || "no models offered"}`);
			} else if (state.kind === "key_valid") lines.push(`${provider}: key valid`);
			else lines.push(`${provider}: ${state.kind === "rejected" ? "rejected" : "not checked"} (${state.reason})`);
		}
		for (const [ref, reason] of this.refused) lines.push(`${ref}: refused (${reason})`);
		return lines;
	}
}

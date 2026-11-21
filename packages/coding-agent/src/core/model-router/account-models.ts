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
	type ModelServiceTier,
	OPENAI_CODEX_CLIENT_VERSION,
	type OpenAICodexAccountModel,
} from "@caupulican/pi-ai";
import {
	type ProviderResponseAccount,
	providerResponseAccountFor,
	sameProviderResponseRoute,
} from "@caupulican/pi-ai/stream";
import { harnessLog } from "../../kernel/harness-log.ts";
import { interfaceText } from "../language/interface-text.ts";
import { awaitPreflight } from "../preflight.ts";
import { bindAccountRead, type RequestAuth } from "../request-auth.ts";

export type AccountModelAvailability = "available" | "unavailable" | "unknown";

/**
 * Why the owner's account cannot use a model: the provider refused this model at request time, the
 * provider rejected the account's key, or the account's listing does not offer the model.
 */
export type AccountModelUnavailableCause =
	| "model_account_refused"
	| "model_account_rejected"
	| "model_account_unlisted";

/** What a provider's account check found. */
export type ProviderAccountState =
	| { readonly kind: "listed"; readonly models: ReadonlyMap<string, OpenAICodexAccountModel> }
	| { readonly kind: "key_valid" }
	| { readonly kind: "rejected"; readonly reason: string }
	| { readonly kind: "unchecked"; readonly reason: string };

/** The registry members the access question needs: whether a credential exists for a model. */
export interface ModelAccessRegistry {
	hasConfiguredAuth(model: Model<Api>): boolean;
}

/**
 * Why the owner cannot reach this model at all, or undefined when they can: no credential, or a provider account that
 * does not offer it (checked with the provider, or refused by it).
 */
export function describeAccessProblem(
	model: Model<Api>,
	registry: ModelAccessRegistry,
	accounts: AccountModelCatalog | undefined,
): string | undefined {
	if (!registry.hasConfiguredAuth(model)) return "has no auth";
	if (accounts?.availability(model) === "unavailable") {
		return `is not available on this account (${accounts.unavailableReason(model) ?? "unavailable"})`;
	}
	return undefined;
}

export interface AccountModelCatalogDeps {
	/** Every model the registry knows. */
	getModels(): readonly Model<Api>[];
	hasConfiguredAuth(model: Model<Api>): boolean;
	/** The request credential for a model (an OAuth access token or API key). */
	getRequestAuth(model: Model<Api>, accountListing?: boolean): Promise<RequestAuth | undefined>;
	fetch?: typeof fetch;
	canReuseAccountIdentity?(): boolean;
}

const ACCOUNT_CHECK_TIMEOUT_MS = 10_000;
const MAX_REASON_CHARS = 200;

interface CurrentAccount {
	readonly scope?: ProviderResponseAccount;
	includes(target: Model<Api>): boolean;
	current(): boolean;
}
interface RefusedRoute {
	readonly receipt: ProviderResponseAccount;
	reason: string;
}
interface ModelRefusals {
	active?: CurrentAccount;
	byAccount: Map<string, RefusedRoute[]>;
}

function bindCurrentAccount(selected: Model<Api>, auth: RequestAuth | undefined): CurrentAccount | undefined {
	if (!auth || auth.canCacheAccountIdentity === false) return undefined;
	const effective = auth.model ?? selected;
	if (effective.provider !== selected.provider || effective.id !== selected.id) return undefined;
	const scope = providerResponseAccountFor(effective, auth);
	if (!scope && (auth.providerAccountKey !== undefined || effective.headers || auth.headers || auth.credentialHeaders))
		return undefined;
	return {
		scope,
		includes: auth.accountListingIncludes ?? ((target) => target === selected || target === effective),
		current() {
			try {
				auth.requestGuard?.(effective, undefined);
				if (!scope) return true;
				const now = providerResponseAccountFor(effective, auth);
				return !!now && now.accountKey === scope.accountKey && sameProviderResponseRoute(now, scope);
			} catch {
				return false;
			}
		},
	};
}

function refusalOnRoute(
	record: ModelRefusals | undefined,
	scope: ProviderResponseAccount | undefined,
): RefusedRoute | undefined {
	return (
		scope && record?.byAccount.get(scope.accountKey)?.find((row) => sameProviderResponseRoute(row.receipt, scope))
	);
}

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
			signal: AbortSignal,
		) => Promise<ProviderAccountState>
	>
> = {
	"openai-codex": async (model, apiKey, fetchImpl, credentialHeaders, signal) => {
		const listed = await listOpenAICodexAccountModels({
			accessToken: apiKey,
			credentialHeaders,
			baseUrl: model.baseUrl,
			clientVersion: OPENAI_CODEX_CLIENT_VERSION,
			fetch: fetchImpl,
			signal,
		});
		return { kind: "listed", models: new Map(listed.map((entry) => [entry.slug, entry])) };
	},
	openrouter: async (model, apiKey, fetchImpl, _headers, signal) => {
		const response = await fetchImpl(`${model.baseUrl.replace(/\/+$/, "")}/key`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal,
		});
		if (response.status === 401 || response.status === 403) {
			return { kind: "rejected", reason: `OpenRouter rejected the key (${response.status})` };
		}
		if (!response.ok) return { kind: "unchecked", reason: `OpenRouter key check returned ${response.status}` };
		return { kind: "key_valid" };
	},
};

/** What a catalog reads of the model registry: its models, which have auth, and each one's request credential. */
export interface AccountModelRegistry {
	getAll(): readonly Model<Api>[];
	hasConfiguredAuth(model: Model<Api>): boolean;
	getApiKeyAndHeaders(
		model: Model<Api>,
		options?: { accountListing?: boolean },
	): Promise<({ ok: true } & RequestAuth) | { ok: false }>;
}

/** The catalog of the accounts a model registry holds credentials for, asked with each model's own request credential. */
export function accountModelCatalogOf(
	registry: AccountModelRegistry,
	canReuseAccountIdentity?: () => boolean,
): AccountModelCatalog {
	return new AccountModelCatalog({
		canReuseAccountIdentity,
		getModels: () => registry.getAll(),
		hasConfiguredAuth: (model) => registry.hasConfiguredAuth(model),
		getRequestAuth: async (model, accountListing) => {
			const auth = await registry.getApiKeyAndHeaders(model, { accountListing });
			return auth.ok ? auth : undefined;
		},
	});
}

export class AccountModelCatalog {
	private readonly deps: AccountModelCatalogDeps;
	private readonly states = new Map<
		string,
		{ state: ProviderAccountState; applies?: (target?: Model<Api>) => boolean }
	>();
	private readonly refusals = new Map<string, Map<string, ModelRefusals>>();
	private readonly checks = new Map<string, { controller: AbortController; done: PromiseWithResolvers<void> }>();

	constructor(deps: AccountModelCatalogDeps) {
		this.deps = deps;
	}

	/** Ask every provider that can answer, for the accounts that have a credential. */
	refresh(): Promise<void> {
		return this.refreshProviders(Object.keys(ACCOUNT_CHECKS));
	}

	async refreshAfterAuthChange(provider: string): Promise<void> {
		const refusals = this.refusals.get(provider);
		if (refusals) for (const record of refusals.values()) record.active = undefined;
		if (!Object.hasOwn(ACCOUNT_CHECKS, provider) && !refusals?.size) return;
		this.states.delete(provider);
		await this.refreshProviders([provider]);
		await this.ready(undefined, provider);
	}

	/** A caller may abandon its wait without ending any provider check. */
	async ready(signal?: AbortSignal, provider?: string): Promise<void> {
		while (!signal?.aborted) {
			const pending: Promise<void>[] = [];
			for (const [name, check] of this.checks) {
				if (provider === undefined || provider === name) pending.push(check.done.promise);
			}
			if (pending.length === 0) return;
			try {
				await awaitPreflight(() => Promise.all(pending), signal);
			} catch (error) {
				if (!signal?.aborted) throw error;
			}
		}
	}

	private async refreshProviders(providers: readonly string[]): Promise<void> {
		let models: readonly Model<Api>[] | undefined;
		const getModels = () => (models ??= this.deps.getModels());
		await Promise.all(providers.map((provider) => this.refreshProvider(provider, getModels)));
	}

	private async refreshProvider(
		provider: string,
		getModels: () => readonly Model<Api>[],
		identityOnly = false,
	): Promise<void> {
		const previous = this.checks.get(provider);
		const check = { controller: new AbortController(), done: Promise.withResolvers<void>() };
		this.checks.set(provider, check);
		previous?.controller.abort();
		try {
			const models = getModels();
			const records = this.refusals.get(provider);
			const listing = !identityOnly && Object.hasOwn(ACCOUNT_CHECKS, provider);
			const listedModel = listing
				? models.find((entry) => entry.provider === provider && this.deps.hasConfiguredAuth(entry))
				: undefined;
			if (listing && !listedModel) this.states.delete(provider);
			if (!listedModel && !records?.size) return;
			const signal = AbortSignal.any([check.controller.signal, AbortSignal.timeout(ACCOUNT_CHECK_TIMEOUT_MS)]);
			const reads = new Map<string, Promise<RequestAuth | undefined>>();
			const read = (model: Model<Api>) => {
				let pending = reads.get(model.id);
				if (!pending) {
					pending = awaitPreflight(
						() => this.deps.getRequestAuth(model, model === listedModel || records?.has(model.id)),
						signal,
					);
					reads.set(model.id, pending);
				}
				return pending;
			};
			const bindings: Promise<void>[] = [];
			if (records?.size) {
				for (const record of records.values()) record.active = undefined;
				if (this.deps.canReuseAccountIdentity?.() !== false) {
					for (const model of models) {
						if (model.provider !== provider) continue;
						const record = records.get(model.id);
						if (record && this.deps.hasConfiguredAuth(model)) {
							bindings.push(this.bindRefusalAccount(model, record, read(model), signal));
						}
					}
				}
			}
			if (listedModel) bindings.push(this.readListing(listedModel, read(listedModel), signal));
			const settled = await Promise.allSettled(bindings);
			for (const binding of settled) if (binding.status === "rejected") throw binding.reason;
		} catch (error) {
			if (this.checks.get(provider) !== check || identityOnly || !Object.hasOwn(ACCOUNT_CHECKS, provider)) return;
			this.states.set(provider, { state: { kind: "unchecked", reason: errorText(error) } });
			harnessLog.warn("router", "an account check failed; its models stay unchecked", () => ({
				provider,
				error: error instanceof Error ? error.name : typeof error,
			}));
		} finally {
			if (this.checks.get(provider) === check) this.checks.delete(provider);
			check.done.resolve();
		}
	}

	private async bindRefusalAccount(
		model: Model<Api>,
		record: ModelRefusals,
		pending: Promise<RequestAuth | undefined>,
		signal: AbortSignal,
	): Promise<void> {
		try {
			const binding = bindCurrentAccount(model, await pending);
			signal.throwIfAborted();
			if (binding?.scope && binding.current()) record.active = binding;
		} catch {
			// An unresolved or superseded credential cannot make a refusal current.
		}
	}

	private async readListing(
		model: Model<Api>,
		pending: Promise<RequestAuth | undefined>,
		signal: AbortSignal,
	): Promise<void> {
		const auth = await pending;
		const request = bindAccountRead(model, auth, signal, this.deps.fetch);
		if (!request || !auth) {
			this.states.set(model.provider, { state: { kind: "unchecked", reason: "no credential resolved" } });
			return;
		}
		const state = await awaitPreflight(
			() =>
				ACCOUNT_CHECKS[model.provider](
					request.model,
					request.apiKey,
					request.fetch,
					request.credentialHeaders,
					signal,
				),
			signal,
		);
		request.verify();
		const witness = bindCurrentAccount(model, auth);
		const applies = (target?: Model<Api>) => witness?.current() === true && (!target || witness.includes(target));
		this.states.set(model.provider, { state, applies });
	}

	private catalogState(target: string | Model<Api>): ProviderAccountState | undefined {
		const provider = typeof target === "string" ? target : target.provider;
		const checked = this.states.get(provider);
		if (!checked || checked.state.kind === "unchecked") return checked?.state;
		if (
			this.deps.canReuseAccountIdentity?.() === false ||
			!checked.applies?.(typeof target === "string" ? undefined : target)
		)
			return undefined;
		return checked.state;
	}

	private currentRefusalAccount(
		record: ModelRefusals | undefined,
		target?: Model<Api>,
	): ProviderResponseAccount | undefined {
		if (!record?.active || this.deps.canReuseAccountIdentity?.() === false) return undefined;
		if (record.active.current()) return !target || record.active.includes(target) ? record.active.scope : undefined;
		record.active = undefined;
		return undefined;
	}

	/** The one classification of why the account cannot use a model: its cause, and the words status and skip text show. */
	private unavailability(
		model: Model<Api>,
		state: ProviderAccountState | undefined,
	): { cause: AccountModelUnavailableCause; reason: string } | undefined {
		const record = this.refusals.get(model.provider)?.get(model.id);
		const current = this.currentRefusalAccount(record, model);
		const refusal = refusalOnRoute(record, current)?.reason;
		if (refusal !== undefined) {
			return { cause: "model_account_refused", reason: `refused by ${model.provider}: ${refusal}` };
		}
		if (state?.kind === "rejected") return { cause: "model_account_rejected", reason: state.reason };
		if (state?.kind === "listed") {
			const listed = state.models.get(model.id);
			if (!listed) {
				return { cause: "model_account_unlisted", reason: `not offered to this ${model.provider} account` };
			}
			if (
				model.openaiCodexAccessProgram &&
				listed.availableAccessPrograms &&
				!listed.availableAccessPrograms.cyber.includes(model.openaiCodexAccessProgram)
			) {
				return {
					cause: "model_account_unlisted",
					reason: `${model.openaiCodexAccessProgram} is not offered to this ${model.provider} account`,
				};
			}
		}
		return undefined;
	}

	/** Why the account cannot use this model; undefined when it can, or when the account has not been checked. */
	unavailableCause(model: Model<Api>): AccountModelUnavailableCause | undefined {
		return this.unavailability(model, this.catalogState(model))?.cause;
	}

	availability(model: Model<Api>): AccountModelAvailability {
		const state = this.catalogState(model);
		if (this.unavailability(model, state)) return "unavailable";
		return !state || state.kind === "unchecked" ? "unknown" : "available";
	}

	/** Account metadata overrides bundled tiers, including an explicit empty list. No request is made here. */
	serviceTiers(model: Model<Api>): readonly ModelServiceTier[] | undefined {
		return this.speedCatalog(model).tiers;
	}

	speedCatalog(model: Model<Api>): {
		tiers: readonly ModelServiceTier[] | undefined;
		defaultTier: string | undefined;
	} {
		const state = this.catalogState(model);
		if (this.unavailability(model, state)) return { tiers: [], defaultTier: undefined };
		const listed = state?.kind === "listed" ? state.models.get(model.id) : undefined;
		return {
			tiers: listed?.serviceTiers ?? model.serviceTiers,
			defaultTier: listed ? listed.defaultServiceTier : model.defaultServiceTier,
		};
	}

	defaultServiceTier(model: Model<Api>): string | undefined {
		return this.speedCatalog(model).defaultTier;
	}

	/** Why a model is unavailable on this account, for status and skip reasons. */
	unavailableReason(model: Model<Api>): string | undefined {
		return this.unavailability(model, this.catalogState(model))?.reason;
	}

	async markRefused(receipt: ProviderResponseAccount, providerMessage: string): Promise<boolean> {
		if (!sameProviderResponseRoute(receipt, receipt)) return false;
		let models = this.refusals.get(receipt.provider);
		if (!models) {
			models = new Map();
			this.refusals.set(receipt.provider, models);
		}
		let record = models.get(receipt.model);
		if (!record) {
			record = { byAccount: new Map() };
			models.set(receipt.model, record);
		}
		const reason = bounded(providerMessage);
		const previous = refusalOnRoute(record, receipt);
		if (previous) previous.reason = reason;
		else {
			const routes = record.byAccount.get(receipt.accountKey);
			const refused = { receipt, reason };
			if (routes) routes.push(refused);
			else record.byAccount.set(receipt.accountKey, [refused]);
		}
		harnessLog.warn("router", "a provider refused a model for the account that sent the request", () => ({
			model: `${receipt.provider}/${receipt.model}`,
		}));
		if (this.deps.canReuseAccountIdentity?.() === false) return false;
		if (!this.currentRefusalAccount(record)) {
			if (this.checks.has(receipt.provider)) await this.ready(undefined, receipt.provider);
			if (!this.currentRefusalAccount(record) && !this.checks.has(receipt.provider)) {
				await this.refreshProvider(receipt.provider, () => this.deps.getModels(), true);
			}
			await this.ready(undefined, receipt.provider);
		}
		return this.isCurrentRefusal(receipt);
	}

	isCurrentRefusal(receipt: ProviderResponseAccount, target?: Model<Api>): boolean {
		const record = this.refusals.get(receipt.provider)?.get(receipt.model);
		const current = this.currentRefusalAccount(record, target);
		return (
			!!current &&
			current.accountKey === receipt.accountKey &&
			sameProviderResponseRoute(current, receipt) &&
			!!refusalOnRoute(record, receipt)
		);
	}

	/** Whether this account's model listing for the provider was fetched, so an absent alternative is a fact about the listing. */
	hasListing(target: string | Model<Api>): boolean {
		return this.catalogState(target)?.kind === "listed";
	}

	/**
	 * The provider's own default for this account: its first offered model (by the provider's
	 * priority) that pi knows, has a credential for, and that was not refused.
	 */
	accountDefault(target: string | Model<Api>): Model<Api> | undefined {
		const provider = typeof target === "string" ? target : target.provider;
		const state = this.catalogState(target);
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
					model !== undefined &&
					this.deps.hasConfiguredAuth(model) &&
					this.catalogState(model) === state &&
					!this.unavailability(model, state),
			);
	}

	/** One line per checked provider, for router status. */
	describe(): string[] {
		const words = interfaceText().localModels.routerAccounts;
		const lines: string[] = [];
		for (const provider of [...this.states.keys()].sort()) {
			const state = this.catalogState(provider);
			if (!state) {
				lines.push(words.notChecked(provider, words.requestIdentityUnknown));
				continue;
			}
			if (state.kind === "listed") {
				const offered = [...state.models.values()]
					.filter((entry) => entry.visibility === "list")
					.sort((a, b) => a.priority - b.priority)
					.map((entry) => entry.slug);
				lines.push(`${provider}: ${offered.join(", ") || words.noModels}`);
			} else if (state.kind === "key_valid") lines.push(words.keyValid(provider));
			else if (state.kind === "rejected") lines.push(words.rejected(provider, state.reason));
			else lines.push(words.notChecked(provider, state.reason));
		}
		for (const [provider, records] of this.refusals) {
			for (const [model, record] of records) {
				const current = this.currentRefusalAccount(record);
				const reason = refusalOnRoute(record, current)?.reason;
				if (reason !== undefined) lines.push(words.refused(`${provider}/${model}`, reason));
			}
		}
		return lines;
	}
}

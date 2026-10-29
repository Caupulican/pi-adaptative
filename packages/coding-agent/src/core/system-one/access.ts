/**
 * The one place System One's provider, model and key are decided. Every System One path (the
 * steering plane, the controller's adapter, model routing, the `systemone` tool) resolves its
 * access here at the moment it evaluates, so a provider switch in settings applies to the next
 * evaluation, and no path can pair one provider's endpoint with another provider's key.
 */

import { getSystemOneProviderDriver, type SystemOneProviderDriver } from "./provider-driver.ts";

/** Which provider System One authenticates with. `auto` prefers the owner's TypeSafe key, then OpenRouter. */
export type SystemOneProviderChoice = "auto" | "typesafe" | "openrouter";

export const SYSTEM_ONE_PROVIDER_CHOICES: readonly SystemOneProviderChoice[] = ["auto", "typesafe", "openrouter"];

/** Explicit disablement wins over retained credentials and injected runtime bindings. */
export function isSystemOneEnabled(
	settings: { getSystemOneSettings(): { enabled?: boolean } },
	options: { enabled?: boolean; disabled?: boolean; env?: NodeJS.ProcessEnv } = {},
): boolean {
	return (
		options.disabled !== true &&
		options.enabled !== false &&
		settings.getSystemOneSettings().enabled !== false &&
		(options.env ?? process.env).PI_SYSTEM_ONE_DISABLED !== "1"
	);
}

export class SystemOneDisabledError extends Error {
	readonly preSend = true;
	constructor() {
		super(
			"System One is disabled. Continue with deterministic checks and root-owned review; no evaluator is called.",
		);
		this.name = "SystemOneDisabledError";
	}
}

/** The providers a choice may use, in order: `auto` tries the owner's TypeSafe key first. */
export function providerCandidates(choice: SystemOneProviderChoice): ("typesafe" | "openrouter")[] {
	return choice === "auto" ? ["typesafe", "openrouter"] : [choice];
}

/** What the choice resolves to right now, for the operator: the provider in force, or what is missing. */
export function describeSystemOneAccess(
	choice: SystemOneProviderChoice,
	hasKey: (provider: "typesafe" | "openrouter") => boolean,
): string {
	const provider = providerCandidates(choice).find(hasKey);
	if (provider) {
		const driver = getSystemOneProviderDriver(provider);
		return `In force: ${driver.displayName} (${driver.model}).`;
	}
	const setup = providerCandidates(choice)
		.map((candidate) => getSystemOneProviderDriver(candidate).formatSetupHelp())
		.join(", or ");
	return `No key for this choice: System One is off until you ${setup}.`;
}

export interface SystemOneAccess {
	readonly driver: SystemOneProviderDriver;
	/** The pinned engine version in the driver's naming. */
	readonly model: string;
	readonly apiKey: string;
}

export interface SystemOneAccessDeps {
	getChoice(): SystemOneProviderChoice;
	isEnabled?(): boolean;
	/** The user's key for a provider (stored credential or its environment variable), if any. */
	getApiKey(provider: "typesafe" | "openrouter"): Promise<string | undefined>;
}

export type SystemOneAccessOutcome =
	| { readonly kind: "ready"; readonly access: SystemOneAccess }
	| { readonly kind: "disabled"; readonly setup: string }
	| { readonly kind: "missing_key"; readonly choice: SystemOneProviderChoice; readonly setup: string };

export class SystemOneAccessResolver {
	private readonly deps: SystemOneAccessDeps;

	constructor(deps: SystemOneAccessDeps) {
		this.deps = deps;
	}

	assertEnabled(): void {
		if (this.deps.isEnabled?.() === false) throw new SystemOneDisabledError();
	}

	/** The access in force right now: an explicit choice uses only that provider's key. */
	async resolve(): Promise<SystemOneAccessOutcome> {
		if (this.deps.isEnabled?.() === false) return { kind: "disabled", setup: new SystemOneDisabledError().message };
		const choice = this.deps.getChoice();
		const candidates = providerCandidates(choice);
		for (const provider of candidates) {
			const apiKey = (await this.deps.getApiKey(provider))?.trim();
			if (this.deps.isEnabled?.() === false)
				return { kind: "disabled", setup: new SystemOneDisabledError().message };
			if (!apiKey) continue;
			const driver = getSystemOneProviderDriver(provider);
			return { kind: "ready", access: { driver, model: driver.model, apiKey } };
		}
		return {
			kind: "missing_key",
			choice,
			setup: candidates.map((provider) => getSystemOneProviderDriver(provider).formatSetupHelp()).join(", or "),
		};
	}
}

/** Every System One key the session holds, for leak scanning: a switch must not unguard the other one. */
export async function systemOneKeys(deps: Pick<SystemOneAccessDeps, "getApiKey">): Promise<string[]> {
	const keys = await Promise.all([deps.getApiKey("typesafe"), deps.getApiKey("openrouter")]);
	return keys.map((key) => key?.trim()).filter((key): key is string => Boolean(key));
}

/**
 * The session's resolver: the choice from settings (read at every call, so a switch applies to the
 * next evaluation) unless `pinned` overrides it, and keys from the session's credential store, then
 * the driver's environment variable.
 */
export function sessionSystemOneAccess(input: {
	getChoice(): SystemOneProviderChoice;
	isEnabled?(): boolean;
	getStoredKey(provider: "typesafe" | "openrouter"): Promise<string | undefined>;
	env?: NodeJS.ProcessEnv;
}): SystemOneAccessResolver & { keys(): Promise<string[]> } {
	const env = input.env ?? process.env;
	const deps: SystemOneAccessDeps = {
		getChoice: input.getChoice,
		isEnabled: input.isEnabled,
		getApiKey: async (provider) =>
			(await input.getStoredKey(provider)) ?? env[getSystemOneProviderDriver(provider).apiKeyEnvVar],
	};
	return Object.assign(new SystemOneAccessResolver(deps), { keys: () => systemOneKeys(deps) });
}

/**
 * The session's System One access from its settings and credential store: the provider choice from
 * `systemOne.provider` (unless `choice` pins one), stored keys without the custom-provider fallback.
 */
export function systemOneAccessFromSession(
	settings: { getSystemOneSettings(): { provider: SystemOneProviderChoice; enabled?: boolean } },
	credentials: {
		getApiKey(provider: string, options: { includeFallback: false }): Promise<string | undefined>;
	},
	choice?: SystemOneProviderChoice,
): SystemOneAccessResolver & { keys(): Promise<string[]> } {
	return sessionSystemOneAccess({
		getChoice: () => choice ?? settings.getSystemOneSettings().provider,
		isEnabled: () => isSystemOneEnabled(settings),
		getStoredKey: (provider) => credentials.getApiKey(provider, { includeFallback: false }),
	});
}

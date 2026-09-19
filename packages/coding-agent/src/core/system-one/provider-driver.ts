/**
 * Open/Closed System One Provider Driver Architecture.
 *
 * Encapsulates provider-specific endpoint URLs, credential sources,
 * model identifier normalization, and drift tolerance behind an extensible interface.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface SystemOneProviderDriver {
	readonly id: string;
	readonly displayName: string;
	readonly defaultModel: string;
	readonly defaultPinnedModel: string;
	readonly decisionsEndpoint: string;
	readonly modelsEndpoint: string;
	readonly apiKeyEnvVar: string;
	readonly loginCommand: string;
	matchesModel(targetModel: string, returnedModel: string): boolean;
	formatSetupHelp(): string;
	getApiKey(): Promise<string | undefined> | string | undefined;
	discoverModels?(signal?: AbortSignal): Promise<string[]>;
}

async function fetchDiscoveredModelIds(
	endpoint: string,
	apiKey: string | undefined,
	signal: AbortSignal | undefined,
	extract: (payload: unknown) => string[] | undefined,
	fallback: string[],
): Promise<string[]> {
	try {
		const headers: Record<string, string> = {};
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		const response = await fetch(endpoint, { headers, signal });
		if (!response.ok) return fallback;
		const extracted = extract(await response.json());
		return extracted && extracted.length > 0 ? extracted : fallback;
	} catch {
		return fallback;
	}
}

export class TypeSafeSystemOneDriver implements SystemOneProviderDriver {
	readonly id = "typesafe";
	readonly displayName = "TypeSafe";
	readonly defaultModel = "jev-latest";
	readonly defaultPinnedModel = "jev-1.13.0";
	readonly decisionsEndpoint = "https://api.typesafe.ai/v1/systemone";
	readonly modelsEndpoint = "https://api.typesafe.ai/v1/models";
	readonly apiKeyEnvVar = "TYPESAFE_API_KEY";
	readonly loginCommand = "/login typesafe";

	matchesModel(targetModel: string, returnedModel: string): boolean {
		return targetModel === returnedModel;
	}

	formatSetupHelp(): string {
		return "use /login typesafe or TYPESAFE_API_KEY";
	}

	getApiKey(): string | undefined {
		return process.env.TYPESAFE_API_KEY;
	}

	async discoverModels(signal?: AbortSignal): Promise<string[]> {
		const key = (await this.getApiKey())?.trim();
		return fetchDiscoveredModelIds(
			this.modelsEndpoint,
			key,
			signal,
			(data) => (data as { models?: string[] }).models,
			[this.defaultModel, this.defaultPinnedModel],
		);
	}
}

export class OpenRouterSystemOneDriver implements SystemOneProviderDriver {
	readonly id = "openrouter";
	readonly displayName = "OpenRouter";
	readonly defaultModel = "typesafe/jev-latest";
	readonly defaultPinnedModel = "typesafe/jev-1.13";
	readonly decisionsEndpoint = "https://openrouter.ai/api/alpha/decisions";
	readonly modelsEndpoint = "https://openrouter.ai/api/v1/models?output_modalities=decisions";
	readonly apiKeyEnvVar = "OPENROUTER_API_KEY";
	readonly loginCommand = "/login openrouter";

	matchesModel(targetModel: string, returnedModel: string): boolean {
		if (targetModel === returnedModel) return true;
		const cleanTarget = targetModel
			.replace(/^~/, "")
			.replace(/^typesafe\//, "")
			.replace(/-\d{8}$/, "");
		const cleanReturned = returnedModel
			.replace(/^~/, "")
			.replace(/^typesafe\//, "")
			.replace(/-\d{8}$/, "");
		if (cleanTarget === cleanReturned) return true;
		if (
			(cleanTarget === "jev-1.13" && cleanReturned === "jev-1.13.0") ||
			(cleanTarget === "jev-1.13.0" && cleanReturned === "jev-1.13")
		)
			return true;
		return false;
	}

	formatSetupHelp(): string {
		return "use /login openrouter or OPENROUTER_API_KEY";
	}

	getApiKey(): string | undefined {
		if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
		try {
			const authFile = join(homedir(), ".pi", "agent", "auth.json");
			if (existsSync(authFile)) {
				const data = JSON.parse(readFileSync(authFile, "utf-8")) as Record<string, { key?: string }>;
				if (data.openrouter?.key) return data.openrouter.key;
			}
		} catch {
			// ignore storage read errors
		}
		return undefined;
	}

	async discoverModels(signal?: AbortSignal): Promise<string[]> {
		const key = (await this.getApiKey())?.trim();
		return fetchDiscoveredModelIds(
			this.modelsEndpoint,
			key,
			signal,
			(data) => (data as { data?: Array<{ id: string }> }).data?.map((m) => m.id),
			[this.defaultModel, this.defaultPinnedModel],
		);
	}
}

const SYSTEM_ONE_PROVIDER_REGISTRY = new Map<string, SystemOneProviderDriver>();

export function registerSystemOneProviderDriver(driver: SystemOneProviderDriver): void {
	SYSTEM_ONE_PROVIDER_REGISTRY.set(driver.id, driver);
}

export function getSystemOneProviderDriver(providerId?: string): SystemOneProviderDriver {
	const id = providerId ?? "typesafe";
	const driver = SYSTEM_ONE_PROVIDER_REGISTRY.get(id);
	if (!driver) {
		const available = Array.from(SYSTEM_ONE_PROVIDER_REGISTRY.keys()).join(", ");
		throw new Error(`Unsupported System One provider: '${id}'. Available providers: ${available}`);
	}
	return driver;
}

// Built-in registrations
registerSystemOneProviderDriver(new TypeSafeSystemOneDriver());
registerSystemOneProviderDriver(new OpenRouterSystemOneDriver());

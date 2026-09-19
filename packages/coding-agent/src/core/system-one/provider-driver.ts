/**
 * Open/Closed System One Provider Driver Architecture.
 *
 * Encapsulates provider-specific endpoint URLs, credential sources,
 * model identifier normalization, and drift tolerance behind an extensible interface.
 */

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
}

export class OpenRouterSystemOneDriver implements SystemOneProviderDriver {
	readonly id = "openrouter";
	readonly displayName = "OpenRouter";
	readonly defaultModel = "typesafe/jev-latest";
	readonly defaultPinnedModel = "typesafe/jev-1.13.0";
	readonly decisionsEndpoint = "https://openrouter.ai/api/alpha/decisions";
	readonly modelsEndpoint = "https://openrouter.ai/api/v1/models";
	readonly apiKeyEnvVar = "OPENROUTER_API_KEY";
	readonly loginCommand = "/login openrouter";

	matchesModel(targetModel: string, returnedModel: string): boolean {
		if (targetModel === returnedModel) return true;
		const cleanTarget = targetModel.replace(/^typesafe\//, "");
		const cleanReturned = returnedModel.replace(/^typesafe\//, "");
		if (cleanTarget === cleanReturned) return true;
		if (targetModel === "typesafe/jev-1.13" && returnedModel === "typesafe/jev-1.13.0") return true;
		if (targetModel === "typesafe/jev-1.13.0" && returnedModel === "typesafe/jev-1.13") return true;
		return false;
	}

	formatSetupHelp(): string {
		return "use /login openrouter or OPENROUTER_API_KEY";
	}

	getApiKey(): string | undefined {
		return process.env.OPENROUTER_API_KEY;
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

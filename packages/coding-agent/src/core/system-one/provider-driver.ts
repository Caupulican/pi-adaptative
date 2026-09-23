/**
 * Open/Closed System One Provider Driver Architecture.
 *
 * Encapsulates provider-specific endpoint URLs, the pinned model id, model identifier normalization and
 * drift tolerance behind an extensible interface. Keys are not a driver's business: they come from the
 * session's AuthStorage, through `SystemOneAccessResolver` (access.ts).
 */

/**
 * The Jev version System One runs, in every path and through either provider: one engine version for
 * all, so the same question never gets answers from two versions. 1.13 is the owner's pinned choice.
 */
export const SYSTEM_ONE_JEV_VERSION = "1.13";

export interface SystemOneProviderDriver {
	readonly id: string;
	readonly displayName: string;
	/** The pinned Jev version, in this provider's model naming. */
	readonly model: string;
	readonly decisionsEndpoint: string;
	readonly modelsEndpoint: string;
	readonly apiKeyEnvVar: string;
	readonly loginCommand: string;
	matchesModel(targetModel: string, returnedModel: string): boolean;
	formatSetupHelp(): string;
}

export class TypeSafeSystemOneDriver implements SystemOneProviderDriver {
	readonly id = "typesafe";
	readonly displayName = "TypeSafe";
	readonly model = `jev-${SYSTEM_ONE_JEV_VERSION}.0`;
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
}

export class OpenRouterSystemOneDriver implements SystemOneProviderDriver {
	readonly id = "openrouter";
	readonly displayName = "OpenRouter";
	readonly model = `typesafe/jev-${SYSTEM_ONE_JEV_VERSION}`;
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

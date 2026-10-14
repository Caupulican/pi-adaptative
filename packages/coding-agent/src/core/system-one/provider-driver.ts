/**
 * Open/Closed System One Provider Driver Architecture.
 *
 * Encapsulates provider-specific endpoint URLs, the pinned model id, model identifier normalization and
 * drift tolerance behind an extensible interface. Keys are not a driver's business: they come from the
 * session's AuthStorage, through `SystemOneAccessResolver` (access.ts).
 */

/**
 * The owner's pinned Jev version for scalar decisions through either provider.
 * Experimental image evaluation has a separate explicit capability pin on its driver.
 */
export const SYSTEM_ONE_JEV_VERSION = "1.13";

export interface SystemOneProviderDriver {
	readonly id: string;
	readonly displayName: string;
	/** The pinned Jev version, in this provider's model naming. */
	readonly model: string;
	/** Explicit experimental image capability; absence refuses image requests before egress. */
	readonly visionModel?: string;
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
	readonly visionModel = "jev-1.14.0";
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

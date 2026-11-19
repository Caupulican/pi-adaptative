import { findEnvKeys, getEnvApiKey } from "@caupulican/pi-ai/env-api-keys";
import { getProviders } from "@caupulican/pi-ai/models";
import { getOAuthProvider, getOAuthProviders } from "@caupulican/pi-ai/oauth";
import chalk from "chalk";
import { AuthStorage } from "../core/auth-storage.ts";
import { ModelRegistry } from "../core/model-registry.ts";
import { resolveCliModel } from "../core/model-resolver.ts";

export interface ProviderAuthReport {
	provider: string;
	configured: boolean;
	source: "stored" | "runtime" | "environment" | "none";
	type?: "api_key" | "oauth";
	status: "valid" | "expired" | "expiring_soon" | "missing" | "error";
	expiresAt?: string;
	expiresInMs?: number;
	tokenRefreshed?: boolean;
	error?: string;
}

export interface AuthCheckOptions {
	provider?: string;
	model?: string;
	json?: boolean;
	noRefresh?: boolean;
}

export interface AuthCheckResult {
	success: boolean;
	providers: ProviderAuthReport[];
}

export function parseAuthCheckArgs(args: string[]): AuthCheckOptions {
	const options: AuthCheckOptions = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") {
			options.json = true;
		} else if (arg === "--no-refresh") {
			options.noRefresh = true;
		} else if (arg === "--provider" && i + 1 < args.length) {
			options.provider = args[++i];
		} else if (arg.startsWith("--provider=")) {
			options.provider = arg.slice("--provider=".length);
		} else if (arg === "--model" && i + 1 < args.length) {
			options.model = args[++i];
		} else if (arg.startsWith("--model=")) {
			options.model = arg.slice("--model=".length);
		}
	}
	return options;
}

/** Upgrade stored, provider-owned model catalogs before CLI model selection on an online launch. */
export async function refreshStaleModelCatalogs(storage: AuthStorage): Promise<void> {
	for (const provider of storage.getOAuthProviders()) {
		const stored = storage.get(provider.id);
		if (!provider.modifyModels || stored?.type !== "oauth" || !provider.needsRefresh?.(stored)) continue;
		const report = await checkProviderAuth(provider.id, storage, {});
		if (report.error) console.error(`Could not refresh the ${provider.id} model catalog. Using cached models.`);
	}
}

export async function checkProviderAuth(
	provider: string,
	authStorage: AuthStorage,
	options: { noRefresh?: boolean } = {},
): Promise<ProviderAuthReport> {
	const stored = authStorage.get(provider);

	if (stored) {
		if (stored.type === "api_key") {
			return {
				provider,
				configured: true,
				source: "stored",
				type: "api_key",
				status: "valid",
			};
		}

		if (stored.type === "oauth") {
			let credential = stored;
			const oauthProvider = getOAuthProvider(provider);
			let tokenRefreshed = false;
			let error: string | undefined;
			if (
				!options.noRefresh &&
				(credential.expires - Date.now() < 5 * 60_000 || oauthProvider?.needsRefresh?.(credential))
			) {
				try {
					const apiKey = await authStorage.getOAuthApiKey(provider);
					const current = authStorage.get(provider);
					if (!apiKey || current?.type !== "oauth") error = "Token refresh returned no stored OAuth credential";
					else {
						tokenRefreshed = current.access !== credential.access || current.expires !== credential.expires;
						credential = current;
						if (oauthProvider?.needsRefresh?.(current))
							error = "Provider account metadata could not be refreshed";
					}
				} catch (err) {
					error = err instanceof Error ? err.message : String(err);
				}
			}
			const expiresAt = new Date(credential.expires).toISOString();
			const expiresInMs = credential.expires - Date.now();
			const status = error
				? "error"
				: expiresInMs <= 0
					? "expired"
					: expiresInMs < 5 * 60_000
						? "expiring_soon"
						: "valid";

			return {
				provider,
				configured: true,
				source: "stored",
				type: "oauth",
				status,
				expiresAt,
				expiresInMs,
				tokenRefreshed,
				error,
			};
		}
	}

	const envKeys = findEnvKeys(provider);
	if (envKeys?.[0] && getEnvApiKey(provider)) {
		return {
			provider,
			configured: true,
			source: "environment",
			type: "api_key",
			status: "valid",
		};
	}

	return {
		provider,
		configured: false,
		source: "none",
		status: "missing",
	};
}

export async function runAuthCheck(
	args: string[],
	storage: AuthStorage = AuthStorage.create(),
	modelRegistry: ModelRegistry = ModelRegistry.create(storage),
): Promise<AuthCheckResult> {
	const options = parseAuthCheckArgs(args);
	const providersToCheck = new Set<string>();
	const reports: ProviderAuthReport[] = [];

	if (options.provider) {
		providersToCheck.add(options.provider);
	} else if (options.model) {
		// Route through the same model resolver every other --model consumer uses, instead of
		// guessing the provider from string shape: a bare id like "gpt-4o" has no slash and is not
		// itself a provider name.
		const resolved = resolveCliModel({ cliModel: options.model, modelRegistry });
		if (resolved.model) {
			providersToCheck.add(resolved.model.provider);
		} else {
			reports.push({
				provider: options.model,
				configured: false,
				source: "none",
				status: "error",
				error: resolved.error ?? `No model matches "${options.model}"`,
			});
		}
	} else {
		for (const p of storage.list()) {
			providersToCheck.add(p);
		}
		for (const p of getOAuthProviders()) {
			providersToCheck.add(p.id);
		}
		for (const p of getProviders()) {
			if (getEnvApiKey(p)) {
				providersToCheck.add(p);
			}
		}
	}

	for (const provider of Array.from(providersToCheck).sort()) {
		const report = await checkProviderAuth(provider, storage, { noRefresh: options.noRefresh });
		reports.push(report);
	}

	const success = reports.every(
		(r) => r.status !== "error" && (options.provider || options.model ? r.configured : true),
	);

	if (options.json) {
		console.log(JSON.stringify({ success, providers: reports }, null, 2));
	} else {
		for (const r of reports) {
			const statusBadge =
				r.status === "valid"
					? chalk.green("✓ valid")
					: r.status === "expiring_soon"
						? chalk.yellow("▲ expiring soon")
						: r.status === "expired"
							? chalk.red("✗ expired")
							: r.status === "error"
								? chalk.red(`✗ error (${r.error})`)
								: chalk.dim("○ not configured");

			const details = [
				r.type ? chalk.dim(`[${r.type}]`) : "",
				r.source ? chalk.dim(`(source: ${r.source})`) : "",
				r.tokenRefreshed ? chalk.cyan("[refreshed]") : "",
				r.expiresAt ? chalk.dim(`expires: ${r.expiresAt}`) : "",
			]
				.filter(Boolean)
				.join(" ");

			console.log(`  ${chalk.bold(r.provider.padEnd(16))} ${statusBadge} ${details}`);
		}
	}

	return { success, providers: reports };
}

export async function handleAuthCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "auth") return false;

	if (args[1] === "check") {
		const result = await runAuthCheck(args.slice(2));
		if (!result.success) {
			process.exitCode = 1;
		}
		return true;
	}

	if (args[1] === "--help" || args[1] === "-h" || !args[1]) {
		console.log(`Usage: pi auth check [options]

Inspect credentials and OAuth token status without starting an interactive session.

Options:
  --provider <name>   Inspect a specific provider
  --model <pattern>   Inspect the provider for a model pattern
  --json              Output report in JSON format
  --no-refresh        Read stored credentials without refreshing tokens or provider account metadata
  --help, -h          Show this help message
`);
		return true;
	}

	return false;
}

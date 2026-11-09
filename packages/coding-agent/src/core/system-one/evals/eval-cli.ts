/**
 * The real System One behind the measurement CLIs (`npm run eval:*`): the credentials and access a session uses, and the
 * adapter over them. A measurement CLI spends System One requests, so it resolves this once and reports an unconfigured
 * System One instead of judging without one. `runEvalCliEntry` runs a CLI's `main` only when its module is the entry.
 */
import { pathToFileURL } from "node:url";
import { AuthStorage } from "../../auth-storage.ts";
import { ModelRegistry } from "../../model-registry.ts";
import { SystemOneReviewer } from "../../review/typesafe-reviewer.ts";
import { createCredentialTextRedactor, redactCredentialValues } from "../../secrets/credential-manager.ts";
import { SettingsManager } from "../../settings-manager.ts";
import { systemOneAccessFromSession } from "../access.ts";
import { SystemOneJevAdapter } from "../adapter.ts";
import { createSystemOneConfig } from "../config.ts";

export type SystemOneEvalSetup =
	| { readonly kind: "ready"; readonly adapter: SystemOneJevAdapter }
	| { readonly kind: "unconfigured"; readonly setup: string };

export async function resolveSystemOneEvalAdapter(): Promise<SystemOneEvalSetup> {
	const settings = SettingsManager.create(process.cwd());
	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);
	const credentialBoundary = {
		getSensitiveValues: async () => modelRegistry.getKnownCredentialValues(),
		createSensitiveTextRedactor: (additionalValues: readonly string[] = []) =>
			createCredentialTextRedactor([...modelRegistry.getKnownCredentialValues(), ...additionalValues]),
		redactSensitiveText: (text: string, additionalValues: readonly string[] = []) =>
			redactCredentialValues(text, [...modelRegistry.getKnownCredentialValues(), ...additionalValues]),
	};
	const access = systemOneAccessFromSession(settings, authStorage);
	const outcome = await access.resolve();
	if (outcome.kind !== "ready") return { kind: "unconfigured", setup: outcome.setup };
	const adapter = new SystemOneJevAdapter(
		new SystemOneReviewer({ access, credentialBoundary }),
		createSystemOneConfig({ enabled: true }),
		{ access, getUserKeys: () => access.keys() },
	);
	return { kind: "ready", adapter };
}

/** Runs a measurement CLI's `main` when `moduleUrl` is the process's entry module, and exits with its code. */
export function runEvalCliEntry(moduleUrl: string, main: (argv: string[]) => Promise<number>): void {
	if (!process.argv[1] || moduleUrl !== pathToFileURL(process.argv[1]).href) return;
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error) => {
			process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
			process.exit(2);
		},
	);
}

import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PackagePublishIntent } from "./delivery-intent.ts";
import type { DeployProofObservation, PublishProofObservation } from "./delivery-proof.ts";

interface PackageManifest {
	readonly name?: unknown;
	readonly version?: unknown;
	readonly private?: unknown;
	readonly scripts?: unknown;
}

export interface TrustedDeployAdapter {
	readonly id: string;
	readonly targets: readonly string[];
	deploy(target: string, options?: { readonly signal?: AbortSignal }): Promise<{ id: string }>;
	/** Independent of deploy()'s return value. Stdout from deploy is not proof. */
	observe(target: string, options?: { readonly signal?: AbortSignal }): Promise<{ deploymentId: string }>;
}

export interface RepoReleaseDelivery {
	publish?(): Promise<{ id: string }>;
	provePublish?(publicationId: string): Promise<PublishProofObservation>;
	deploy?(target: string): Promise<{ id: string }>;
	proveDeploy?(target: string): Promise<DeployProofObservation>;
}

const RELEASE_TIMEOUT_MS = 120_000;
const RELEASE_OUTPUT_MAX_BYTES = 1_048_576;

function readManifest(repoRoot: string): PackageManifest | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		return parsed as PackageManifest;
	} catch {
		return undefined;
	}
}

function publishableIdentity(manifest: PackageManifest | undefined): { name: string; version: string } | undefined {
	if (!manifest || manifest.private === true) return undefined;
	if (typeof manifest.name !== "string" || manifest.name.length === 0) return undefined;
	if (typeof manifest.version !== "string" || manifest.version.length === 0) return undefined;
	return { name: manifest.name, version: manifest.version };
}

function npmInvocation(configured: readonly string[] | undefined): { command: string; args: string[] } {
	if (configured && configured.length > 0 && configured[0]) {
		const [command, ...args] = configured;
		return { command, args };
	}
	return { command: process.platform === "win32" ? "npm.cmd" : "npm", args: [] };
}

function run(command: string, args: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			[...args],
			{
				cwd,
				encoding: "utf8",
				maxBuffer: RELEASE_OUTPUT_MAX_BYTES,
				timeout: RELEASE_TIMEOUT_MS,
				signal,
				env: { ...process.env, NPM_CONFIG_YES: "false", GIT_TERMINAL_PROMPT: "0" },
			},
			(error, stdout, stderr) => {
				if (error) {
					const detail = String(stderr || error.message)
						.trim()
						.slice(0, 500);
					reject(new Error(detail || error.message));
					return;
				}
				resolve(String(stdout).trim());
			},
		);
	});
}

function registryArgs(registry: string | undefined): string[] {
	return registry ? ["--registry", registry] : [];
}

function readNpmRegistry(repoRoot: string, command: string, args: readonly string[]): string | undefined {
	try {
		const value = execFileSyncRegistry(command, [...args, "config", "get", "registry"], repoRoot);
		if (!value || value === "undefined" || value === "null") return undefined;
		return value;
	} catch {
		return undefined;
	}
}

function execFileSyncRegistry(command: string, args: readonly string[], cwd: string): string {
	return execFileSync(command, args, {
		cwd,
		encoding: "utf8",
		timeout: 15_000,
		maxBuffer: RELEASE_OUTPUT_MAX_BYTES,
		env: { ...process.env, NPM_CONFIG_YES: "false", GIT_TERMINAL_PROMPT: "0" },
	}).trim();
}

/**
 * Publish for a public package, and deploy only through trusted adapters passed at admission.
 * A package.json `deploy` script is an ordinary npm script. It is not a deployment adapter.
 * Publish does not run package lifecycle scripts. Proof never reuses deploy stdout.
 */
export function createRepoReleaseDelivery(
	repoRoot: string,
	options?: {
		readonly npmCommand?: readonly string[];
		readonly packageIntent?: PackagePublishIntent | false;
		readonly adapters?: readonly TrustedDeployAdapter[];
		readonly signal?: AbortSignal;
	},
): RepoReleaseDelivery | undefined {
	const manifestIdentity = publishableIdentity(readManifest(repoRoot));
	const intent = options?.packageIntent;
	const grantedIntent = intent === false || intent === undefined ? undefined : intent;
	const publishIdentity =
		grantedIntent?.packageName && grantedIntent.version
			? { name: grantedIntent.packageName, version: grantedIntent.version, registry: grantedIntent.registry }
			: intent === undefined && manifestIdentity
				? { name: manifestIdentity.name, version: manifestIdentity.version, registry: undefined }
				: undefined;
	const adapters = options?.adapters ?? [];
	if (!publishIdentity && adapters.length === 0) return undefined;
	const npm = npmInvocation(options?.npmCommand);
	const frozenRegistry = publishIdentity
		? (publishIdentity.registry ?? readNpmRegistry(repoRoot, npm.command, npm.args))
		: undefined;
	const publishFrozen = publishIdentity ? { ...publishIdentity, registry: frozenRegistry } : undefined;

	function adapterFor(target: string): TrustedDeployAdapter | undefined {
		return adapters.find((adapter) => adapter.targets.includes(target));
	}

	return {
		...(publishFrozen
			? {
					async publish() {
						const current = publishableIdentity(readManifest(repoRoot));
						if (!current || current.name !== publishFrozen.name || current.version !== publishFrozen.version) {
							throw new Error("package_identity_mismatch");
						}
						const registryNow = readNpmRegistry(repoRoot, npm.command, npm.args);
						if (publishFrozen.registry && registryNow && registryNow !== publishFrozen.registry) {
							throw new Error("package_registry_mismatch");
						}
						await run(
							npm.command,
							[...npm.args, "publish", "--ignore-scripts", ...registryArgs(publishFrozen.registry)],
							repoRoot,
							options?.signal,
						);
						return { id: `${publishFrozen.name}@${publishFrozen.version}` };
					},
					async provePublish(publicationId: string) {
						const expected = `${publishFrozen.name}@${publishFrozen.version}`;
						if (publicationId !== expected) throw new Error("publish_id_mismatch");
						const parsed = JSON.parse(
							await run(
								npm.command,
								[...npm.args, "view", expected, "version", "--json", ...registryArgs(publishFrozen.registry)],
								repoRoot,
								options?.signal,
							),
						) as unknown;
						if (typeof parsed !== "string" || parsed !== publishFrozen.version) {
							throw new Error("publish_id_mismatch");
						}
						return { publicationId: expected };
					},
				}
			: {}),
		...(adapters.length > 0
			? {
					async deploy(target: string) {
						const adapter = adapterFor(target);
						if (!adapter) throw new Error(`Deploy unavailable for ${target}`);
						const deployed = await adapter.deploy(target, { signal: options?.signal });
						if (!deployed.id) throw new Error("Deploy adapter did not report a deployment id");
						return { id: deployed.id };
					},
					async proveDeploy(target: string) {
						const adapter = adapterFor(target);
						if (!adapter) throw new Error("deploy_proof_unavailable");
						const observed = await adapter.observe(target, { signal: options?.signal });
						if (!observed.deploymentId) throw new Error("deploy_proof_unavailable");
						return { target, deploymentId: observed.deploymentId };
					},
				}
			: {}),
	};
}

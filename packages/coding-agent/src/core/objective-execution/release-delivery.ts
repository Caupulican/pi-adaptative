import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreparedPackageArtifact } from "./delivery-coordinator.ts";
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
	observe(
		target: string,
		options?: { readonly signal?: AbortSignal },
	): Promise<{ deploymentId: string; deployedRevision?: string; artifactDigest?: string }>;
}

export class TrustedDeployAdapterRegistry {
	private readonly adapters: TrustedDeployAdapter[] = [];

	register(adapter: TrustedDeployAdapter): void {
		const existing = this.adapters.findIndex((entry) => entry.id === adapter.id);
		if (existing >= 0) this.adapters[existing] = adapter;
		else this.adapters.push(adapter);
	}

	find(adapterId: string, target: string): TrustedDeployAdapter | undefined {
		return this.adapters.find((adapter) => adapter.id === adapterId && adapter.targets.includes(target));
	}

	list(): readonly TrustedDeployAdapter[] {
		return this.adapters;
	}
}

export interface RepoReleaseDelivery {
	preparePublish?(): Promise<PreparedPackageArtifact>;
	publish?(): Promise<{ id: string; integrity: string; packageName: string; version: string; registry: string }>;
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

function artifactIdentity(bytes: Buffer): { shasum: string; integrity: string } {
	return {
		shasum: createHash("sha1").update(bytes).digest("hex"),
		integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
	};
}

/**
 * Publish the admission package intent, and deploy only through trusted adapters.
 * A package.json `deploy` script is an ordinary npm script. It is not a deployment adapter.
 * A public manifest does not grant publish. The registry is the one frozen on the intent.
 * Publish packs once with scripts disabled and uploads that tarball. Proof compares registry bytes.
 */
export function createRepoReleaseDelivery(
	repoRoot: string,
	options?: {
		readonly npmCommand?: readonly string[];
		readonly packageIntent?: PackagePublishIntent | false;
		readonly adapters?: readonly TrustedDeployAdapter[] | TrustedDeployAdapterRegistry;
		readonly signal?: AbortSignal;
	},
): RepoReleaseDelivery | undefined {
	const intent = options?.packageIntent;
	const grantedIntent = intent === false || intent === undefined ? undefined : intent;
	const publishIdentity =
		grantedIntent?.packageName && grantedIntent.version && grantedIntent.registry
			? { name: grantedIntent.packageName, version: grantedIntent.version, registry: grantedIntent.registry }
			: undefined;
	const adapters = options?.adapters;
	const liveRegistry = adapters && !Array.isArray(adapters) ? adapters : undefined;
	const staticAdapters = Array.isArray(adapters) ? adapters : [];
	if (!publishIdentity && !liveRegistry && staticAdapters.length === 0) return undefined;
	const npm = npmInvocation(options?.npmCommand);
	let prepared: PreparedPackageArtifact | undefined;
	let preparedDir: string | undefined;

	function adapterList(): readonly TrustedDeployAdapter[] {
		if (!adapters) return [];
		if (isAdapterRegistry(adapters)) return adapters.list();
		return adapters;
	}

	function adapterFor(target: string): TrustedDeployAdapter | undefined {
		return adapterList().find((adapter) => adapter.targets.includes(target));
	}

	async function prepare(): Promise<PreparedPackageArtifact> {
		if (!publishIdentity) throw new Error("package_identity_unavailable");
		if (prepared) return prepared;
		const current = publishableIdentity(readManifest(repoRoot));
		if (!current || current.name !== publishIdentity.name || current.version !== publishIdentity.version) {
			throw new Error("package_identity_mismatch");
		}
		const directory = mkdtempSync(join(tmpdir(), "pi-publish-"));
		preparedDir = directory;
		const packed = await run(
			npm.command,
			[...npm.args, "pack", "--ignore-scripts", "--workspaces=false", "--json", "--pack-destination", directory],
			repoRoot,
			options?.signal,
		);
		const filename = packedTarballName(packed);
		if (!filename) throw new Error("package_artifact_unavailable");
		const tarball = join(directory, filename);
		const bytes = readFileSync(tarball);
		const identity = artifactIdentity(bytes);
		prepared = {
			id: `${publishIdentity.name}@${publishIdentity.version}`,
			packageName: publishIdentity.name,
			version: publishIdentity.version,
			registry: publishIdentity.registry,
			integrity: identity.integrity,
			shasum: identity.shasum,
		};
		return prepared;
	}

	return {
		...(publishIdentity
			? {
					preparePublish: prepare,
					async publish() {
						const artifact = await prepare();
						const current = publishableIdentity(readManifest(repoRoot));
						if (!current || current.name !== artifact.packageName || current.version !== artifact.version) {
							throw new Error("package_identity_mismatch");
						}
						if (!preparedDir) throw new Error("package_artifact_unavailable");
						const packedName = findPackedTarball(preparedDir);
						if (!packedName) throw new Error("package_artifact_unavailable");
						const bytes = readFileSync(join(preparedDir, packedName));
						const identity = artifactIdentity(bytes);
						if (identity.integrity !== artifact.integrity || identity.shasum !== artifact.shasum) {
							throw new Error("package_artifact_mismatch");
						}
						await run(
							npm.command,
							[
								...npm.args,
								"publish",
								join(preparedDir, packedName),
								"--ignore-scripts",
								"--workspaces=false",
								...registryArgs(artifact.registry),
							],
							repoRoot,
							options?.signal,
						);
						return {
							id: artifact.id,
							integrity: artifact.integrity,
							packageName: artifact.packageName,
							version: artifact.version,
							registry: artifact.registry ?? "",
						};
					},
					async provePublish(publicationId: string) {
						if (!prepared) throw new Error("publish_proof_unavailable");
						if (publicationId !== prepared.id) throw new Error("publish_id_mismatch");
						const parsed = JSON.parse(
							await run(
								npm.command,
								[
									...npm.args,
									"view",
									prepared.id,
									"dist",
									"--json",
									"--workspaces=false",
									...registryArgs(prepared.registry),
								],
								repoRoot,
								options?.signal,
							),
						) as { integrity?: unknown; shasum?: unknown };
						if (parsed.integrity !== prepared.integrity || parsed.shasum !== prepared.shasum) {
							throw new Error("publish_integrity_mismatch");
						}
						return {
							publicationId: prepared.id,
							packageName: prepared.packageName,
							version: prepared.version,
							registry: prepared.registry,
							integrity: prepared.integrity,
							shasum: prepared.shasum,
						};
					},
				}
			: {}),
		...(liveRegistry || staticAdapters.length > 0
			? {
					async deploy(target: string) {
						const adapter = adapterFor(target);
						if (!adapter) throw new Error("deploy_adapter_unavailable");
						const deployed = await adapter.deploy(target, { signal: options?.signal });
						if (!deployed.id) throw new Error("Deploy adapter did not report a deployment id");
						return { id: deployed.id };
					},
					async proveDeploy(target: string) {
						const adapter = adapterFor(target);
						if (!adapter) throw new Error("deploy_proof_unavailable");
						const observed = await adapter.observe(target, { signal: options?.signal });
						if (!observed.deploymentId) throw new Error("deploy_proof_unavailable");
						return {
							target,
							deploymentId: observed.deploymentId,
							...(observed.deployedRevision ? { deployedRevision: observed.deployedRevision } : {}),
							...(observed.artifactDigest ? { artifactDigest: observed.artifactDigest } : {}),
						};
					},
				}
			: {}),
	};
}

function isAdapterRegistry(
	value: readonly TrustedDeployAdapter[] | TrustedDeployAdapterRegistry,
): value is TrustedDeployAdapterRegistry {
	return !Array.isArray(value);
}

function packedTarballName(packed: string): string | undefined {
	const start = packed.indexOf("[");
	const json = start >= 0 ? packed.slice(start) : packed;
	try {
		const parsed = JSON.parse(json) as unknown;
		const entry = Array.isArray(parsed) ? parsed[0] : parsed;
		if (typeof entry === "string" && entry.endsWith(".tgz")) return entry.split(/[\\/]/u).pop();
		if (entry && typeof entry === "object" && "filename" in entry) {
			const filename = (entry as { filename?: unknown }).filename;
			if (typeof filename === "string" && filename.endsWith(".tgz")) return filename.split(/[\\/]/u).pop();
		}
	} catch {
		// Fall through to a plain filename line.
	}
	const line = packed
		.split(/\r?\n/u)
		.map((entry) => entry.trim())
		.find((entry) => entry.endsWith(".tgz"));
	return line?.split(/[\\/]/u).pop();
}

function findPackedTarball(directory: string): string | undefined {
	return readdirSync(directory).find((name) => name.endsWith(".tgz"));
}

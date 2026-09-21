import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeployProofObservation, PublishProofObservation } from "./delivery-proof.ts";

interface PackageManifest {
	readonly name?: unknown;
	readonly version?: unknown;
	readonly private?: unknown;
	readonly scripts?: unknown;
}

export interface RepoReleaseDelivery {
	publish?(): Promise<{ id: string }>;
	provePublish?(publicationId: string): Promise<PublishProofObservation>;
	deploy?(target: string): Promise<{ id: string }>;
	proveDeploy?(target: string): Promise<DeployProofObservation>;
}

function readManifest(repoRoot: string): PackageManifest | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		return parsed as PackageManifest;
	} catch {
		return undefined;
	}
}

function scriptsOf(manifest: PackageManifest | undefined): Record<string, string> {
	const scripts = manifest?.scripts;
	if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return {};
	const out: Record<string, string> = {};
	for (const [name, command] of Object.entries(scripts)) {
		if (typeof command === "string" && command.length > 0) out[name] = command;
	}
	return out;
}

function publishableId(manifest: PackageManifest | undefined): string | undefined {
	if (!manifest || manifest.private === true) return undefined;
	if (typeof manifest.name !== "string" || manifest.name.length === 0) return undefined;
	if (typeof manifest.version !== "string" || manifest.version.length === 0) return undefined;
	return `${manifest.name}@${manifest.version}`;
}

function isDeployScript(name: string): boolean {
	if (name === "deploy") return true;
	if (!name.startsWith("deploy:") || name.endsWith(":status")) return false;
	const target = name.slice("deploy:".length);
	return target.length > 0 && !target.includes(":");
}

function hasDeploy(scripts: Record<string, string>): boolean {
	return Object.keys(scripts).some(isDeployScript);
}

function deployScriptFor(scripts: Record<string, string>, target: string): string | undefined {
	if (scripts[`deploy:${target}`]) return `deploy:${target}`;
	if (scripts.deploy) return "deploy";
	return undefined;
}

function statusScriptFor(scripts: Record<string, string>, target: string): string | undefined {
	if (scripts[`deploy:${target}:status`]) return `deploy:${target}:status`;
	if (scripts["deploy:status"]) return "deploy:status";
	return undefined;
}

function npmInvocation(configured: readonly string[] | undefined): { command: string; args: string[] } {
	if (configured && configured.length > 0 && configured[0]) {
		const [command, ...args] = configured;
		return { command, args };
	}
	return { command: process.platform === "win32" ? "npm.cmd" : "npm", args: [] };
}

function run(command: string, args: readonly string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			[...args],
			{
				cwd,
				encoding: "utf8",
				maxBuffer: 8 * 1024 * 1024,
				env: { ...process.env, NPM_CONFIG_YES: "false", GIT_TERMINAL_PROMPT: "0" },
			},
			(error, stdout, stderr) => {
				if (error) {
					const detail = String(stderr || error.message).trim();
					reject(new Error(detail || error.message));
					return;
				}
				resolve(String(stdout).trim());
			},
		);
	});
}

/**
 * Publish and deploy for the session repo. Absent when the repo has neither a publishable
 * package nor a deploy script. Publish does not run package lifecycle scripts.
 * A status script is an independent deployment id. Without one, the id is the deploy script's stdout.
 */
export function createRepoReleaseDelivery(
	repoRoot: string,
	options?: { readonly npmCommand?: readonly string[] },
): RepoReleaseDelivery | undefined {
	const initial = readManifest(repoRoot);
	const publishable = publishableId(initial) !== undefined;
	const deployable = hasDeploy(scriptsOf(initial));
	if (!publishable && !deployable) return undefined;
	const npm = npmInvocation(options?.npmCommand);
	const observedDeployIds = new Map<string, string>();

	async function npmRun(script: string, target: string): Promise<string> {
		return run(npm.command, [...npm.args, "run", script, "--silent", "--", target], repoRoot);
	}

	return {
		...(publishable
			? {
					async publish() {
						const id = publishableId(readManifest(repoRoot));
						if (!id) throw new Error("Package publish unavailable");
						await run(npm.command, [...npm.args, "publish", "--ignore-scripts"], repoRoot);
						return { id };
					},
					async provePublish(publicationId: string) {
						const at = publicationId.lastIndexOf("@");
						if (at <= 0) throw new Error("Package publish proof id has no version");
						const name = publicationId.slice(0, at);
						const parsed = JSON.parse(
							await run(npm.command, [...npm.args, "view", publicationId, "version", "--json"], repoRoot),
						) as unknown;
						if (typeof parsed !== "string" || parsed.length === 0) {
							throw new Error("Package publish proof did not return a version");
						}
						return { publicationId: `${name}@${parsed}` };
					},
				}
			: {}),
		...(deployable
			? {
					async deploy(target: string) {
						const scripts = scriptsOf(readManifest(repoRoot));
						const script = deployScriptFor(scripts, target);
						if (!script) throw new Error(`Deploy unavailable for ${target}`);
						const status = statusScriptFor(scripts, target);
						const stdout = await npmRun(script, target);
						const id = status ? await npmRun(status, target) : stdout;
						if (!id) {
							throw new Error(
								status ? "Deploy status returned an empty id" : "Deploy script did not report a deployment id",
							);
						}
						observedDeployIds.set(target, id);
						return { id };
					},
					async proveDeploy(target: string) {
						const status = statusScriptFor(scriptsOf(readManifest(repoRoot)), target);
						const id = status ? await npmRun(status, target) : observedDeployIds.get(target);
						if (!id) throw new Error(status ? "Deploy status returned an empty id" : "Deploy proof unavailable");
						return { target, deploymentId: id };
					},
				}
			: {}),
	};
}

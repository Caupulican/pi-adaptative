/**
 * Immutable delivery authority compiled once from the trusted start instruction.
 * Later repo state may validate this intent. It cannot expand or retarget it.
 * Coding verbs (fix, implement, repair, refactor, build) grant nothing here.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withoutInheritedGitLocation } from "../exec.ts";
import { npmExec } from "./npm-exec.ts";

export interface GitCommitIntent {
	readonly exact: true;
	readonly message?: string;
}

export interface GitPushIntent {
	readonly exact: true;
	readonly remote: string;
	readonly ref: string;
}

export interface GitTagIntent {
	readonly exact: true;
	readonly name: string;
	readonly push: boolean;
	/** Frozen at admission when this tag is pushed. Branch push is a separate intent. */
	readonly remote?: string;
}

export interface PackagePublishIntent {
	readonly packageName: string;
	readonly version: string;
	readonly registry?: string;
}

export interface DeployAdapterIntent {
	readonly target: string;
	readonly adapterId: string;
}

export interface GithubReleaseIntent {
	readonly repository: string;
	readonly tag: string;
}

export interface DeliveryUnresolved {
	readonly action: "push" | "tag" | "tag_push" | "package_publish" | "github_release";
	readonly error: string;
}

export interface DeliveryIntent {
	readonly git: {
		readonly commit: false | GitCommitIntent;
		readonly push: false | GitPushIntent;
		readonly tag: false | GitTagIntent;
	};
	readonly packagePublish: false | PackagePublishIntent;
	readonly deploy: readonly DeployAdapterIntent[];
	readonly githubRelease: false | GithubReleaseIntent;
	readonly unresolved: readonly DeliveryUnresolved[];
	readonly baselineDirty: boolean;
}

export interface DeliveryAdmission {
	readonly upstream: { readonly remote: string; readonly ref: string } | null;
	readonly baselineDirty: boolean;
	readonly detached: boolean;
	readonly packageName?: string;
	readonly packageVersion?: string;
	readonly packagePrivate?: boolean;
	readonly registry?: string;
	/** Present when this admission was read from a real checkout. Registry is read from here once. */
	readonly repoRoot?: string;
}

export interface DeliveryInitialGitGrant {
	readonly commit?: boolean;
	readonly push?: boolean;
	readonly force_push?: boolean;
	readonly create_branch?: boolean;
	readonly create_tag?: boolean;
	readonly push_remote?: string;
	readonly push_ref?: string;
	readonly tag_name?: string;
	readonly tag_push?: boolean;
	readonly commit_message?: string;
}

export interface DeliveryInitialReleaseGrant {
	readonly package_publish?: boolean;
	readonly github_release?: boolean;
	readonly deploy_targets?: readonly string[];
	readonly package_name?: string;
	readonly package_version?: string;
	readonly package_registry?: string;
	readonly github_repository?: string;
	readonly github_tag?: string;
	readonly deploy_adapters?: readonly DeployAdapterIntent[];
}

export function emptyDeliveryIntent(): DeliveryIntent {
	return {
		git: { commit: false, push: false, tag: false },
		packagePublish: false,
		deploy: [],
		githubRelease: false,
		unresolved: [],
		baselineDirty: false,
	};
}

/** One admission observation. A failed read is dirty and detached so delivery cannot assume a clean tree. */
export function observeDeliveryAdmission(repoRoot: string): DeliveryAdmission {
	const failed: DeliveryAdmission = { upstream: null, baselineDirty: true, detached: true };
	try {
		const branch = gitText(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
		const porcelain = gitText(repoRoot, ["status", "--porcelain"]);
		const detached = branch === "HEAD";
		let upstream: DeliveryAdmission["upstream"] = null;
		if (!detached) {
			try {
				const remote = gitText(repoRoot, ["config", "--get", `branch.${branch}.remote`]);
				const ref = gitText(repoRoot, ["config", "--get", `branch.${branch}.merge`]);
				if (remote && ref.startsWith("refs/")) upstream = { remote, ref };
			} catch {
				upstream = null;
			}
		}
		const manifest = readPackageIdentity(repoRoot);
		return {
			upstream,
			baselineDirty: porcelain.length > 0,
			detached,
			packageName: manifest?.name,
			packageVersion: manifest?.version,
			packagePrivate: manifest?.privatePackage,
			repoRoot,
		};
	} catch {
		return failed;
	}
}

export function compileDeliveryIntent(input: {
	readonly grantCommit: boolean;
	readonly grantPush: boolean;
	readonly grantTag: boolean;
	readonly grantPublish: boolean;
	readonly grantGithubRelease: boolean;
	readonly deployTargets: readonly string[];
	readonly git?: DeliveryInitialGitGrant;
	readonly release?: DeliveryInitialReleaseGrant;
	readonly admission?: DeliveryAdmission;
}): DeliveryIntent {
	const unresolved: DeliveryUnresolved[] = [];
	const admission = input.admission;
	const baselineDirty = admission?.baselineDirty === true;

	const commit: false | GitCommitIntent = input.grantCommit
		? { exact: true, ...(input.git?.commit_message ? { message: input.git.commit_message } : {}) }
		: false;

	let push: false | GitPushIntent = false;
	if (input.grantPush) {
		const remote = input.git?.push_remote ?? admission?.upstream?.remote;
		const ref = input.git?.push_ref ?? admission?.upstream?.ref;
		if (!remote || !ref?.startsWith("refs/") || admission?.detached) {
			unresolved.push({ action: "push", error: "push_upstream_unavailable" });
		} else {
			push = { exact: true, remote, ref };
		}
	}

	const tagName = input.git?.tag_name?.trim();
	const tagPush = input.git?.tag_push === true;
	let tag: false | GitTagIntent = false;
	if (input.grantTag) {
		if (!tagName) unresolved.push({ action: "tag", error: "tag_name_required" });
		else if (tagPush) {
			const remote = input.git?.push_remote ?? admission?.upstream?.remote;
			if (!remote || admission?.detached) {
				unresolved.push({ action: "tag_push", error: "tag_push_upstream_unavailable" });
				tag = { exact: true, name: tagName, push: true };
			} else tag = { exact: true, name: tagName, push: true, remote };
		} else tag = { exact: true, name: tagName, push: false };
	}

	let packagePublish: false | PackagePublishIntent = false;
	if (input.grantPublish) {
		const packageName =
			input.release?.package_name ?? (admission?.packagePrivate ? undefined : admission?.packageName);
		const version =
			input.release?.package_version ?? (admission?.packagePrivate ? undefined : admission?.packageVersion);
		if (!packageName || !version) {
			unresolved.push({ action: "package_publish", error: "package_identity_unavailable" });
		} else {
			const registry =
				input.release?.package_registry ??
				admission?.registry ??
				(admission?.repoRoot ? readDefaultNpmRegistry(admission.repoRoot) : undefined);
			if (admission?.repoRoot && !registry) {
				unresolved.push({ action: "package_publish", error: "package_registry_unavailable" });
			} else packagePublish = { packageName, version, ...(registry ? { registry } : {}) };
		}
	}

	const adapters = input.release?.deploy_adapters ?? [];
	const deploy: DeployAdapterIntent[] = [];
	for (const target of input.deployTargets) {
		const adapter = adapters.find((entry) => entry.target === target && entry.adapterId.length > 0);
		if (adapter) deploy.push({ target, adapterId: adapter.adapterId });
	}

	let githubRelease: false | GithubReleaseIntent = false;
	if (input.grantGithubRelease) {
		const repository = input.release?.github_repository?.trim();
		const githubTag = input.release?.github_tag?.trim();
		if (repository && githubTag) githubRelease = { repository, tag: githubTag };
		unresolved.push({ action: "github_release", error: "github_release_unsupported" });
	}

	return {
		git: { commit, push, tag },
		packagePublish,
		deploy,
		githubRelease,
		unresolved,
		baselineDirty,
	};
}

export function unresolvedError(intent: DeliveryIntent, action: DeliveryUnresolved["action"]): string | undefined {
	return intent.unresolved.find((entry) => entry.action === action)?.error;
}

/** One registry read at admission, from the checkout npm would publish. Publish does not read this again. */
function readDefaultNpmRegistry(repoRoot: string): string | undefined {
	try {
		const npm = npmExec();
		const value = execFileSync(npm.command, [...npm.args, "config", "get", "registry", "--workspaces=false"], {
			cwd: repoRoot,
			encoding: "utf8",
			timeout: 15_000,
			maxBuffer: 1_048_576,
			env: { ...process.env, NPM_CONFIG_YES: "false", GIT_TERMINAL_PROMPT: "0" },
		}).trim();
		if (!value || value === "undefined" || value === "null") return undefined;
		return value;
	} catch {
		return undefined;
	}
}

function gitText(repoRoot: string, args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd: repoRoot,
		encoding: "utf8",
		timeout: 15_000,
		maxBuffer: 1_048_576,
		env: { ...withoutInheritedGitLocation(), GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
	}).trim();
}

function readPackageIdentity(
	repoRoot: string,
): { name?: string; version?: string; privatePackage: boolean } | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const record = parsed as { name?: unknown; version?: unknown; private?: unknown };
		return {
			name: typeof record.name === "string" && record.name.length > 0 ? record.name : undefined,
			version: typeof record.version === "string" && record.version.length > 0 ? record.version : undefined,
			privatePackage: record.private === true,
		};
	} catch {
		return undefined;
	}
}

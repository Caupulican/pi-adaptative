import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { resourceDir } from "../agent-paths.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import type { OrchestrationProfile } from "./contracts.ts";
import {
	OrchestrationProfileError,
	OrchestrationProfileRegistry,
	parseOrchestrationProfile,
	validateOrchestrationProfile,
} from "./profile-registry.ts";

export type OrchestrationProfileScope = "global" | "project";

export interface OrchestrationProfileDiagnostic {
	scope: OrchestrationProfileScope;
	path: string;
	message: string;
}

export interface OrchestrationProfileLoadResult {
	registry: OrchestrationProfileRegistry;
	profiles: readonly OrchestrationProfile[];
	diagnostics: readonly OrchestrationProfileDiagnostic[];
}

const PROFILE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function authoredProfile(profile: OrchestrationProfile): Omit<OrchestrationProfile, "sourcePath"> {
	const { sourcePath: _sourcePath, ...authored } = profile;
	return authored;
}

function messageFrom(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class OrchestrationProfileStore {
	private readonly agentDir: string;
	private readonly cwd: string;

	constructor(options: { agentDir: string; cwd: string }) {
		this.agentDir = resolve(options.agentDir);
		this.cwd = resolve(options.cwd);
	}

	directory(scope: OrchestrationProfileScope): string {
		return scope === "global"
			? join(resourceDir("profiles", this.agentDir), "orchestration")
			: join(this.cwd, CONFIG_DIR_NAME, "profiles", "orchestration");
	}

	filePath(profileId: string, scope: OrchestrationProfileScope): string {
		if (!PROFILE_ID_PATTERN.test(profileId)) {
			throw new OrchestrationProfileError(
				"Orchestration profile IDs must be 1-128 characters using only letters, numbers, '.', '_', or '-'.",
			);
		}
		return join(this.directory(scope), `${profileId}.json`);
	}

	load(): OrchestrationProfileLoadResult {
		const diagnostics: OrchestrationProfileDiagnostic[] = [];
		const globalProfiles = this.loadScope("global", diagnostics);
		const projectProfiles = this.loadScope("project", diagnostics);
		const profilesById = new Map(globalProfiles.map((profile) => [profile.profileId, profile]));
		for (const profile of projectProfiles) profilesById.set(profile.profileId, profile);
		let profiles = [...profilesById.values()].sort((left, right) => left.profileId.localeCompare(right.profileId));
		let removed = true;
		while (removed) {
			removed = false;
			const available = new Map(profiles.map((profile) => [profile.profileId, profile]));
			profiles = profiles.filter((profile) => {
				const invalidTarget = profile.dispatchProfileIds.find((profileId) => {
					const target = available.get(profileId);
					return !target || target.role === "orchestrator";
				});
				if (!invalidTarget) return true;
				removed = true;
				diagnostics.push({
					scope: profile.sourcePath?.startsWith(this.directory("project")) ? "project" : "global",
					path: profile.sourcePath ?? profile.profileId,
					message: `Dispatch target '${invalidTarget}' is missing or is another orchestrator.`,
				});
				return false;
			});
		}
		return {
			registry: new OrchestrationProfileRegistry(profiles),
			profiles,
			diagnostics,
		};
	}

	save(
		profile: OrchestrationProfile,
		scope: OrchestrationProfileScope,
		options: { overwrite?: boolean } = {},
	): string {
		validateOrchestrationProfile(profile);
		const filePath = this.filePath(profile.profileId, scope);
		withFileLockSync(filePath, () => {
			if (!options.overwrite && existsSync(filePath)) {
				throw new OrchestrationProfileError(
					`Orchestration profile '${profile.profileId}' already exists in ${scope} scope.`,
				);
			}
			writeFileAtomicSync(filePath, `${JSON.stringify(authoredProfile(profile), null, 2)}\n`);
		});
		return filePath;
	}

	private loadScope(
		scope: OrchestrationProfileScope,
		diagnostics: OrchestrationProfileDiagnostic[],
	): OrchestrationProfile[] {
		const directory = this.directory(scope);
		if (!existsSync(directory)) return [];
		let entries: string[];
		try {
			entries = readdirSync(directory)
				.filter((entry) => entry.endsWith(".json"))
				.sort((left, right) => left.localeCompare(right));
		} catch (error) {
			diagnostics.push({ scope, path: directory, message: messageFrom(error) });
			return [];
		}
		const profilesById = new Map<string, OrchestrationProfile>();
		for (const entry of entries) {
			const sourcePath = join(directory, entry);
			try {
				const profile = parseOrchestrationProfile(JSON.parse(readFileSync(sourcePath, "utf-8")), sourcePath);
				if (profilesById.has(profile.profileId)) {
					throw new OrchestrationProfileError(
						`Duplicate orchestration profile '${profile.profileId}' in ${scope} scope.`,
					);
				}
				profilesById.set(profile.profileId, profile);
			} catch (error) {
				diagnostics.push({ scope, path: sourcePath, message: messageFrom(error) });
			}
		}
		return [...profilesById.values()];
	}
}

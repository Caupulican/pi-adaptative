import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { resourceDir } from "../agent-paths.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readBoundedDirectoryNamesSync, readBoundedTextFileSync } from "../util/bounded-file.ts";
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
/** A fully populated profile is below this cap; reject expansion before JSON parsing or persistence. */
const MAX_PROFILE_FILE_BYTES = 512 * 1024;
const MAX_PROFILE_DIRECTORY_ENTRIES = 512;

function authoredProfile(profile: OrchestrationProfile): Omit<OrchestrationProfile, "sourcePath"> {
	const { sourcePath: _sourcePath, ...authored } = profile;
	return authored;
}

function messageFrom(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function serializeBoundedProfile(profile: Omit<OrchestrationProfile, "sourcePath">): string {
	const serialized = `${JSON.stringify(profile, null, 2)}\n`;
	if (Buffer.byteLength(serialized, "utf-8") > MAX_PROFILE_FILE_BYTES) {
		throw new OrchestrationProfileError("Orchestration profile exceeds its byte limit.");
	}
	return serialized;
}

export class OrchestrationProfileStore {
	private readonly agentDir: string;
	private readonly cwd: string;
	private readonly projectTrusted: boolean;

	constructor(options: { agentDir: string; cwd: string; projectTrusted: boolean }) {
		this.agentDir = resolve(options.agentDir);
		this.cwd = resolve(options.cwd);
		this.projectTrusted = options.projectTrusted;
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
		const projectProfiles = this.projectTrusted ? this.loadScope("project", diagnostics) : [];
		if (!this.projectTrusted && existsSync(this.directory("project"))) {
			diagnostics.push({
				scope: "project",
				path: this.directory("project"),
				message: "Project orchestration profiles were not loaded because the project is untrusted.",
			});
		}
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
				const verifier = profile.verificationProfileId ? available.get(profile.verificationProfileId) : undefined;
				const invalidVerifier =
					profile.verificationProfileId && verifier?.role !== "verifier"
						? profile.verificationProfileId
						: undefined;
				const unauthorizedVerifier =
					profile.role === "orchestrator"
						? profile.dispatchProfileIds
								.map((profileId) => available.get(profileId))
								.find(
									(target) =>
										target?.verificationProfileId &&
										!profile.dispatchProfileIds.includes(target.verificationProfileId),
								)
						: undefined;
				if (!invalidTarget && !invalidVerifier && !unauthorizedVerifier) return true;
				removed = true;
				const message = invalidTarget
					? `Dispatch target '${invalidTarget}' is missing or is another orchestrator.`
					: invalidVerifier
						? `Verifier target '${invalidVerifier}' is missing or is not a verifier.`
						: `Dispatched profile '${unauthorizedVerifier?.profileId}' requires verifier '${unauthorizedVerifier?.verificationProfileId}', which this orchestrator does not authorize.`;
				diagnostics.push({
					scope: profile.sourcePath?.startsWith(this.directory("project")) ? "project" : "global",
					path: profile.sourcePath ?? profile.profileId,
					message,
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
		if (scope === "project" && !this.projectTrusted) {
			throw new OrchestrationProfileError(
				"Project is not trusted; refusing to write project orchestration profiles.",
			);
		}
		validateOrchestrationProfile(profile);
		const filePath = this.filePath(profile.profileId, scope);
		const serialized = serializeBoundedProfile(authoredProfile(profile));
		// Keep the save path as strict as load: typed callers cannot persist a record the loader rejects.
		parseOrchestrationProfile(JSON.parse(serialized));
		withFileLockSync(filePath, () => {
			if (!options.overwrite && existsSync(filePath)) {
				throw new OrchestrationProfileError(
					`Orchestration profile '${profile.profileId}' already exists in ${scope} scope.`,
				);
			}
			writeFileAtomicSync(filePath, serialized);
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
			entries = readBoundedDirectoryNamesSync(
				directory,
				MAX_PROFILE_DIRECTORY_ENTRIES,
				"Orchestration profiles directory",
			)
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
				const profile = parseOrchestrationProfile(
					JSON.parse(readBoundedTextFileSync(sourcePath, MAX_PROFILE_FILE_BYTES, "Orchestration profile")),
					sourcePath,
				);
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

/**
 * Settings storage adapters: the seam the settings manager reads and writes its three layers through (the global
 * settings file, the project file and the directory profile), with the file-backed and the in-memory implementations.
 * The manager owns the in-memory generation; the storage owns locking, atomic writes and the host-transition journal.
 */

import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync } from "fs";
import { dirname, join } from "path";
import { CONFIG_DIR_NAME, getProfilesDir } from "../../config.ts";
import { withHostFileWrite } from "../../utils/host-write-transition.ts";
import { resolvePath } from "../../utils/paths.ts";
import { configFile, hostTransitionsFile } from "../agent-paths.ts";
import { acquireFileLockSync, LOW_LATENCY_FILE_LOCK_OPTIONS, writeFileAtomicSync } from "../util/atomic-file.ts";
import { getDirectoryResourceProfileInfo } from "./settings-rules.ts";
import type { DirectoryResourceProfileInfo, SettingsScope } from "./settings-schema.ts";

export interface SettingsSnapshot {
	global?: string;
	project?: string;
	directoryProfile?: string;
}

export interface SettingsStorage {
	/** Hold all settings scopes while validating and replacing the global generation. */
	updateGlobalSnapshot?(fn: (snapshot: SettingsSnapshot) => string): void;
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
	getProfilesDir?(): string;
	/** Base directory used to resolve explicit ./ or ../ profile references. */
	getProfileResolutionBaseDir?(): string;
}

export class FileSettingsStorage implements SettingsStorage {
	private profileResolutionBaseDir: string;
	private globalSettingsPath: string;
	private projectSettingsPath: string;
	/** The journal every session on this agent directory explains its settings writes from (`host-transitions.jsonl`). */
	private readonly hostTransitions: string;
	private directoryProfileInfo: DirectoryResourceProfileInfo;
	private legacyDirectoryProfilePath: string;
	private profilesDir: string;

	constructor(cwd: string, agentDir: string) {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		this.profileResolutionBaseDir = resolvedCwd;
		this.globalSettingsPath = configFile(resolvedAgentDir, "settings.json");
		this.projectSettingsPath = join(resolvedCwd, CONFIG_DIR_NAME, "settings.json");
		this.hostTransitions = hostTransitionsFile(resolvedAgentDir);
		this.directoryProfileInfo = getDirectoryResourceProfileInfo(resolvedCwd, resolvedAgentDir);
		this.legacyDirectoryProfilePath = join(
			resolvedAgentDir,
			"resource-profiles",
			this.directoryProfileInfo.hash,
			"settings.json",
		);
		this.profilesDir = getProfilesDir(resolvedAgentDir);
	}

	getDirectoryResourceProfileInfo(): DirectoryResourceProfileInfo {
		return { ...this.directoryProfileInfo };
	}

	getProfilesDir(): string {
		return this.profilesDir;
	}

	getProfileResolutionBaseDir(): string {
		return this.profileResolutionBaseDir;
	}

	readDirectoryResourceProfile(): string | undefined {
		const path = this.directoryProfileInfo.path;
		if (existsSync(path)) return readFileSync(path, "utf-8");
		return existsSync(this.legacyDirectoryProfilePath)
			? readFileSync(this.legacyDirectoryProfilePath, "utf-8")
			: undefined;
	}

	private removeMigratedDirectoryProfile(): void {
		if (!existsSync(this.legacyDirectoryProfilePath)) return;
		try {
			rmSync(this.legacyDirectoryProfilePath, { force: true });
		} catch {
			return;
		}
		for (const directory of [
			dirname(this.legacyDirectoryProfilePath),
			dirname(dirname(this.legacyDirectoryProfilePath)),
		]) {
			try {
				rmdirSync(directory);
			} catch {}
		}
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path =
			scope === "global"
				? this.globalSettingsPath
				: scope === "project"
					? this.projectSettingsPath
					: this.directoryProfileInfo.path;
		const dir = dirname(path);
		const legacyPath = scope === "directoryProfile" ? this.legacyDirectoryProfilePath : undefined;

		const releases: Array<() => void> = [];
		let migratedLegacy = false;
		try {
			const legacyExists = legacyPath !== undefined && existsSync(legacyPath);
			const canonicalExists = existsSync(path);
			let currentPath = canonicalExists ? path : legacyExists ? (legacyPath ?? path) : path;
			const fileExists = canonicalExists || legacyExists;

			// Directory-profile locks always follow legacy -> canonical order, including a partial migration
			// where both files exist. This keeps old and new SDK clients from deadlocking each other.
			if (legacyPath && legacyExists) {
				releases.push(acquireFileLockSync(legacyPath, LOW_LATENCY_FILE_LOCK_OPTIONS));
			}
			if (canonicalExists) releases.push(acquireFileLockSync(path, LOW_LATENCY_FILE_LOCK_OPTIONS));

			// A legacy directory overlay can race another process that already knows the canonical path.
			// Hold the legacy lock, then bind to the canonical lock before deriving the update.
			if (legacyExists && !canonicalExists) {
				if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
				releases.push(acquireFileLockSync(path, LOW_LATENCY_FILE_LOCK_OPTIONS));
				if (existsSync(path)) currentPath = path;
			}

			const current = fileExists ? readFileSync(currentPath, "utf-8") : undefined;
			const next = fn(current);
			if (next !== undefined) {
				// Only create directory when we actually need to write
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				if (releases.length === 0) {
					releases.push(acquireFileLockSync(path, LOW_LATENCY_FILE_LOCK_OPTIONS));
				}
				withHostFileWrite(path, next, () => writeFileAtomicSync(path, next), this.hostTransitions);
				migratedLegacy = legacyExists;
			}
		} finally {
			for (const release of releases.reverse()) release();
			if (migratedLegacy) this.removeMigratedDirectoryProfile();
		}
	}
	updateGlobalSnapshot(fn: (snapshot: SettingsSnapshot) => string): void {
		const releases: Array<() => void> = [];
		try {
			for (const path of [
				this.globalSettingsPath,
				this.projectSettingsPath,
				this.legacyDirectoryProfilePath,
				this.directoryProfileInfo.path,
			]) {
				releases.push(acquireFileLockSync(path, LOW_LATENCY_FILE_LOCK_OPTIONS));
			}
			const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf-8") : undefined);
			const snapshot = {
				global: read(this.globalSettingsPath),
				project: read(this.projectSettingsPath),
				directoryProfile: read(this.directoryProfileInfo.path) ?? read(this.legacyDirectoryProfilePath),
			};
			const next = fn(snapshot);
			withHostFileWrite(
				this.globalSettingsPath,
				next,
				() => writeFileAtomicSync(this.globalSettingsPath, next),
				this.hostTransitions,
			);
		} finally {
			for (const release of releases.reverse()) release();
		}
	}
}

export class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;
	private directoryProfile: string | undefined;

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : scope === "project" ? this.project : this.directoryProfile;
		const next = fn(current);
		if (next === undefined) {
			return;
		}
		if (scope === "global") {
			this.global = next;
			return;
		}
		if (scope === "project") {
			this.project = next;
			return;
		}
		this.directoryProfile = next;
	}
	updateGlobalSnapshot(fn: (snapshot: SettingsSnapshot) => string): void {
		this.global = fn({ global: this.global, project: this.project, directoryProfile: this.directoryProfile });
	}
}

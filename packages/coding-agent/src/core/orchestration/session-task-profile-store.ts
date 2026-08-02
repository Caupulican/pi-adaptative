import type { SessionEntry, SessionManager } from "@caupulican/pi-agent-core/node";
import type { OrchestrationProfile } from "./contracts.ts";
import { parseOrchestrationProfile } from "./profile-registry.ts";

export const SESSION_TASK_PROFILE_CUSTOM_TYPE = "session_task_profile";
export const MAX_SESSION_TASK_PROFILES = 32;
const BRANCH_STORAGE_REQUIRED = "session task profiles require branch-aware session storage";

export interface SessionTaskProfileRecord {
	baseProfileId: string;
	authorProfileId?: string;
	profile: OrchestrationProfile;
}

export interface SessionTaskProfileLoadResult {
	records: SessionTaskProfileRecord[];
	registry: ReadonlyMap<string, SessionTaskProfileRecord>;
	diagnostics: string[];
}

interface PersistedSessionTaskProfileRecord {
	version: 1;
	baseProfileId: string;
	authorProfileId?: string;
	profile: OrchestrationProfile;
}

function parseRecord(value: unknown): SessionTaskProfileRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("session task profile record must be an object");
	}
	const candidate = value as Partial<PersistedSessionTaskProfileRecord>;
	const keys = Object.keys(candidate);
	if (
		candidate.version !== 1 ||
		keys.some((key) => !["version", "baseProfileId", "authorProfileId", "profile"].includes(key)) ||
		typeof candidate.baseProfileId !== "string" ||
		candidate.baseProfileId.length === 0 ||
		(candidate.authorProfileId !== undefined &&
			(typeof candidate.authorProfileId !== "string" || candidate.authorProfileId.length === 0))
	) {
		throw new Error("session task profile record is invalid");
	}
	return {
		baseProfileId: candidate.baseProfileId,
		...(candidate.authorProfileId ? { authorProfileId: candidate.authorProfileId } : {}),
		profile: parseOrchestrationProfile(candidate.profile),
	};
}

function cloneRecord(record: SessionTaskProfileRecord): SessionTaskProfileRecord {
	return structuredClone(record);
}

/**
 * Append-only task-profile storage on the active session branch.
 *
 * The common append path walks only entries added since the cached leaf. Branching away from the
 * cached leaf deliberately rebuilds from parent links so abandoned task profiles cannot leak into
 * the active branch.
 */
export class SessionTaskProfileStore {
	private readonly sessionManager: SessionManager;
	private cachedLeafId: string | null | undefined;
	private cachedResult: SessionTaskProfileLoadResult = {
		records: [],
		registry: new Map(),
		diagnostics: [],
	};

	constructor(sessionManager: SessionManager) {
		this.sessionManager = sessionManager;
	}

	load(): SessionTaskProfileLoadResult {
		if (typeof this.sessionManager.getLeafId !== "function" || typeof this.sessionManager.getEntry !== "function") {
			this.cachedLeafId = undefined;
			this.cachedResult = {
				records: [],
				registry: new Map(),
				diagnostics: [BRANCH_STORAGE_REQUIRED],
			};
			return this.cloneResult(this.cachedResult);
		}
		const leafId = this.sessionManager.getLeafId();
		if (this.cachedLeafId === leafId) return this.cloneResult(this.cachedResult);

		const appended: SessionEntry[] = [];
		let cursor = leafId;
		while (cursor !== null && cursor !== this.cachedLeafId) {
			const entry = this.sessionManager.getEntry(cursor);
			if (!entry) {
				cursor = null;
				break;
			}
			appended.push(entry);
			cursor = entry.parentId;
		}

		const extendsCache = this.cachedLeafId !== undefined && cursor === this.cachedLeafId;
		const records = extendsCache ? this.cachedResult.records.map(cloneRecord) : [];
		const diagnostics = extendsCache ? [...this.cachedResult.diagnostics] : [];
		const registry = new Map(records.map((record) => [record.profile.profileId, record]));

		for (let index = appended.length - 1; index >= 0; index--) {
			const entry = appended[index];
			if (entry.type !== "custom" || entry.customType !== SESSION_TASK_PROFILE_CUSTOM_TYPE) continue;
			try {
				const record = parseRecord(entry.data);
				if (records.length >= MAX_SESSION_TASK_PROFILES) {
					diagnostics.push(`ignored ${record.profile.profileId}: session task profile limit exceeded`);
					continue;
				}
				if (registry.has(record.profile.profileId)) {
					diagnostics.push(`ignored duplicate session task profile ${record.profile.profileId}`);
					continue;
				}
				records.push(record);
				registry.set(record.profile.profileId, record);
			} catch (error) {
				diagnostics.push(error instanceof Error ? error.message : String(error));
			}
		}

		this.cachedLeafId = leafId;
		this.cachedResult = { records, registry, diagnostics };
		return this.cloneResult(this.cachedResult);
	}

	append(input: SessionTaskProfileRecord): SessionTaskProfileRecord {
		if (
			typeof this.sessionManager.getLeafId !== "function" ||
			typeof this.sessionManager.getEntry !== "function" ||
			typeof this.sessionManager.appendCustomEntry !== "function"
		) {
			throw new Error(BRANCH_STORAGE_REQUIRED);
		}
		const loaded = this.load();
		if (loaded.records.length >= MAX_SESSION_TASK_PROFILES) {
			throw new Error(`session task profile limit (${MAX_SESSION_TASK_PROFILES}) reached`);
		}
		if (loaded.registry.has(input.profile.profileId)) {
			throw new Error(`session task profile '${input.profile.profileId}' already exists`);
		}
		const record = cloneRecord(input);
		parseOrchestrationProfile(record.profile);
		const persisted: PersistedSessionTaskProfileRecord = {
			version: 1,
			baseProfileId: record.baseProfileId,
			...(record.authorProfileId ? { authorProfileId: record.authorProfileId } : {}),
			profile: record.profile,
		};
		this.sessionManager.appendCustomEntry(SESSION_TASK_PROFILE_CUSTOM_TYPE, persisted);
		const registry = new Map(loaded.registry);
		registry.set(record.profile.profileId, record);
		this.cachedLeafId = this.sessionManager.getLeafId();
		this.cachedResult = {
			records: [...loaded.records, record],
			registry,
			diagnostics: loaded.diagnostics,
		};
		return cloneRecord(record);
	}

	private cloneResult(result: SessionTaskProfileLoadResult): SessionTaskProfileLoadResult {
		const records = result.records.map(cloneRecord);
		return {
			records,
			registry: new Map(records.map((record) => [record.profile.profileId, record])),
			diagnostics: [...result.diagnostics],
		};
	}
}

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
	MAX_DOTENV_VARIABLES,
	parseDotenvDocument,
	validateDotenvValue,
	validateDotenvVariableName,
} from "./secret-dotenv.ts";

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROJECT_KEY_PATTERN = /^(?:git|local):[a-f0-9]{64}$/;
const MAX_PROFILE_CHARS = 96;
const MAX_DESCRIPTION_CHARS = 256;
const MAX_PROJECT_BINDINGS = 64;
const MAX_SESSION_KEY_BYTES = 16 * 1024;

export type CredentialManagerErrorCode =
	| "ambiguous_project_binding"
	| "invalid_description"
	| "invalid_profile"
	| "invalid_project_identity"
	| "invalid_provider_record"
	| "invalid_session_key"
	| "owner_setup_required"
	| "profile_exists"
	| "profile_not_found"
	| "project_not_bound";

export class CredentialManagerError extends Error {
	readonly code: CredentialManagerErrorCode;

	constructor(code: CredentialManagerErrorCode, message: string) {
		super(message);
		this.name = "CredentialManagerError";
		this.code = code;
	}
}

export type CredentialStorageErrorCode =
	| "malformed_provider_data"
	| "not_connected"
	| "profile_not_found"
	| "provider_command_failed"
	| "provider_unavailable";

export class CredentialStorageError extends Error {
	readonly code: CredentialStorageErrorCode;

	constructor(code: CredentialStorageErrorCode, message: string) {
		super(message);
		this.name = "CredentialStorageError";
		this.code = code;
	}
}

export interface CredentialProjectIdentity {
	key: string;
	root: string;
	label: string;
	portable: boolean;
}

export type CredentialProjectResolver = (cwd: string) => Promise<CredentialProjectIdentity>;

export interface CredentialVariable {
	name: string;
	value: string;
}

export interface CredentialProfileRecord {
	profile: string;
	description?: string;
	variables: CredentialVariable[];
	projectKeys: string[];
}

export interface StoredCredentialProfileSummary {
	profile: string;
	description?: string;
	variableNames: string[];
	projectKeys: string[];
}

export type CredentialStorageProvider = "bitwarden_password_manager" | "bitwarden_secrets_manager";

export interface MachineCredentialSession {
	provider: CredentialStorageProvider;
	sessionKey: string;
}

export type MachineCredentialSessionResolver = (signal?: AbortSignal) => Promise<MachineCredentialSession | undefined>;

export interface CredentialProfileStorage {
	connect(sessionKey: string, signal?: AbortSignal, provider?: CredentialStorageProvider): Promise<void>;
	refresh?(signal?: AbortSignal): Promise<void>;
	listProfiles(signal?: AbortSignal): Promise<StoredCredentialProfileSummary[]>;
	readProfile(profile: string, signal?: AbortSignal): Promise<CredentialProfileRecord>;
	writeProfile(record: CredentialProfileRecord, signal?: AbortSignal): Promise<void>;
	deleteProfile(profile: string, signal?: AbortSignal): Promise<void>;
	lock(): void;
}

export interface CredentialProfileSummary {
	profile: string;
	description?: string;
	variableNames: string[];
	boundToCurrentProject: boolean;
}

export interface CredentialActivationResult {
	status: "activated";
	profile: string;
	variableNames: string[];
	project: string;
}

export interface CredentialMutationResult {
	status: "bound" | "removed" | "stored";
	profile: string;
	variableNames: string[];
	project?: string;
	portable?: boolean;
}

export interface CredentialConnectionStatus {
	connected: boolean;
	sessionAvailable: boolean;
}

export interface CredentialManagerOptions {
	storage: CredentialProfileStorage;
	resolveProject: CredentialProjectResolver;
	initialSessionKey?: string;
	resolveMachineSession?: MachineCredentialSessionResolver;
	onEnvironmentChanged?: () => void;
}

interface ActiveCredentialEnvironment {
	profile: string;
	root: string;
	values: Record<string, string>;
}

export function validateCredentialProfileName(profile: string): string {
	if (!PROFILE_PATTERN.test(profile) || profile.length > MAX_PROFILE_CHARS) {
		throw new CredentialManagerError(
			"invalid_profile",
			"Credential profile names must use 1-96 portable letters, digits, dots, underscores, or hyphens.",
		);
	}
	return profile;
}

export function validateCredentialDescription(description: string | undefined): string | undefined {
	if (description === undefined) return undefined;
	if (
		description.length === 0 ||
		description.length > MAX_DESCRIPTION_CHARS ||
		description.includes("\0") ||
		/[\r\n]/.test(description)
	) {
		throw new CredentialManagerError(
			"invalid_description",
			"Credential descriptions must be a single printable line of at most 256 characters.",
		);
	}
	return description;
}

function validateProjectIdentity(identity: CredentialProjectIdentity): CredentialProjectIdentity {
	if (
		!PROJECT_KEY_PATTERN.test(identity.key) ||
		!isAbsolute(identity.root) ||
		identity.label.length === 0 ||
		identity.label.length > 256 ||
		/[\0\r\n]/.test(identity.label)
	) {
		throw new CredentialManagerError("invalid_project_identity", "The current project identity is invalid.");
	}
	return { ...identity, root: canonicalizeExistingPath(identity.root) };
}

export function validateCredentialProfileRecord(record: CredentialProfileRecord): CredentialProfileRecord {
	validateCredentialProfileName(record.profile);
	validateCredentialDescription(record.description);
	if (record.variables.length === 0 || record.variables.length > MAX_DOTENV_VARIABLES) {
		throw new CredentialManagerError("invalid_provider_record", "Credential profile has an invalid variable count.");
	}
	const variableNames = new Set<string>();
	for (const variable of record.variables) {
		try {
			validateDotenvVariableName(variable.name);
			validateDotenvValue(variable.value);
		} catch {
			throw new CredentialManagerError("invalid_provider_record", "Credential profile contains invalid variables.");
		}
		if (variableNames.has(variable.name)) {
			throw new CredentialManagerError(
				"invalid_provider_record",
				"Credential profile contains duplicate variables.",
			);
		}
		variableNames.add(variable.name);
	}
	if (
		record.projectKeys.length === 0 ||
		record.projectKeys.length > MAX_PROJECT_BINDINGS ||
		new Set(record.projectKeys).size !== record.projectKeys.length ||
		record.projectKeys.some((key) => !PROJECT_KEY_PATTERN.test(key))
	) {
		throw new CredentialManagerError(
			"invalid_provider_record",
			"Credential profile contains invalid project bindings.",
		);
	}
	return record;
}

function validateSessionKey(sessionKey: string): string {
	if (
		sessionKey.trim().length === 0 ||
		sessionKey.includes("\0") ||
		/[\r\n]/.test(sessionKey) ||
		Buffer.byteLength(sessionKey, "utf8") > MAX_SESSION_KEY_BYTES
	) {
		throw new CredentialManagerError("invalid_session_key", "The Bitwarden session key is invalid.");
	}
	return sessionKey;
}

function isPathInside(root: string, target: string): boolean {
	const pathFromRoot = relative(root, target);
	return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function canonicalizeExistingPath(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

function cloneEnvironment(values: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(values));
}

function findReplaceableProfile(
	summaries: readonly StoredCredentialProfileSummary[],
	profile: string,
	replaceExisting: boolean | undefined,
): StoredCredentialProfileSummary | undefined {
	const existing = summaries.find((summary) => summary.profile === profile);
	if (existing && replaceExisting !== true) {
		throw new CredentialManagerError(
			"profile_exists",
			"Credential profile already exists; replacement must be explicitly allowed.",
		);
	}
	return existing;
}

export class CredentialManager {
	private readonly storage: CredentialProfileStorage;
	private readonly resolveProject: CredentialProjectResolver;
	private readonly resolveMachineSession: MachineCredentialSessionResolver | undefined;
	private readonly onEnvironmentChanged: () => void;
	private readonly activeEnvironments = new Map<string, ActiveCredentialEnvironment>();
	private readonly sensitiveValues = new Set<string>();
	private pendingSessionKey: string | undefined;
	private pendingStorageProvider: CredentialStorageProvider | undefined;
	private sessionKeyForRedaction: string | undefined;
	private connectionPromise: Promise<void> | undefined;
	private connectionGeneration = 0;
	private connected = false;

	constructor(options: CredentialManagerOptions) {
		this.storage = options.storage;
		this.resolveProject = options.resolveProject;
		this.resolveMachineSession = options.resolveMachineSession;
		this.onEnvironmentChanged = options.onEnvironmentChanged ?? (() => {});
		this.pendingSessionKey =
			options.initialSessionKey ??
			(options.resolveMachineSession === undefined ? process.env.BW_SESSION : undefined);
		this.pendingStorageProvider = this.pendingSessionKey ? "bitwarden_password_manager" : undefined;
		this.sessionKeyForRedaction = this.pendingSessionKey;
		this.rebuildSensitiveValues();
	}

	get status(): CredentialConnectionStatus {
		return {
			connected: this.connected,
			sessionAvailable:
				this.connected || Boolean(this.pendingSessionKey) || this.resolveMachineSession !== undefined,
		};
	}

	async connect(sessionKey: string, signal?: AbortSignal): Promise<void> {
		const previousConnection = this.connectionPromise;
		this.connectionGeneration++;
		let privateSessionKey = validateSessionKey(sessionKey);
		this.pendingSessionKey = privateSessionKey;
		this.pendingStorageProvider = "bitwarden_password_manager";
		this.sessionKeyForRedaction = privateSessionKey;
		this.rebuildSensitiveValues();
		this.connected = false;
		try {
			if (previousConnection) {
				try {
					await previousConnection;
				} catch {
					// The superseded connection is expected to fail its generation check.
				}
			}
			await this.ensureConnected(signal);
		} finally {
			privateSessionKey = "";
		}
	}

	async ensureAvailable(signal?: AbortSignal): Promise<CredentialConnectionStatus> {
		await this.ensureConnected(signal);
		return this.status;
	}

	async listForProject(cwd: string, signal?: AbortSignal): Promise<CredentialProfileSummary[]> {
		const { identity, summaries } = await this.refreshProjectProfiles(cwd, signal);
		return summaries.map((summary) => ({
			profile: validateCredentialProfileName(summary.profile),
			...(summary.description ? { description: validateCredentialDescription(summary.description) } : {}),
			variableNames: summary.variableNames.map(validateDotenvVariableName),
			boundToCurrentProject: summary.projectKeys.includes(identity.key),
		}));
	}

	async activateForProject(cwd: string, profile?: string, signal?: AbortSignal): Promise<CredentialActivationResult> {
		const { generation, identity, summaries } = await this.refreshProjectProfiles(cwd, signal);
		let selected: StoredCredentialProfileSummary | undefined;
		if (profile !== undefined) {
			validateCredentialProfileName(profile);
			selected = summaries.find((summary) => summary.profile === profile);
			if (!selected) throw new CredentialManagerError("profile_not_found", "Credential profile was not found.");
			if (!selected.projectKeys.includes(identity.key)) {
				throw new CredentialManagerError(
					"project_not_bound",
					"Credential profile is not authorized for the current project.",
				);
			}
		} else {
			const candidates = summaries.filter((summary) => summary.projectKeys.includes(identity.key));
			if (candidates.length === 0) {
				throw new CredentialManagerError(
					"profile_not_found",
					"No credential profile is bound to the current project. The owner can configure one with /secrets.",
				);
			}
			if (candidates.length > 1) {
				throw new CredentialManagerError(
					"ambiguous_project_binding",
					"Multiple credential profiles are bound to the current project; select a profile by name.",
				);
			}
			[selected] = candidates;
		}

		if (!selected) throw new CredentialManagerError("profile_not_found", "Credential profile was not found.");
		const record = validateCredentialProfileRecord(await this.storage.readProfile(selected.profile, signal));
		this.assertAccessGeneration(generation);
		if (!record.projectKeys.includes(identity.key)) {
			throw new CredentialManagerError(
				"project_not_bound",
				"Credential profile is not authorized for the current project.",
			);
		}
		this.activate(identity.root, record);
		return {
			status: "activated",
			profile: record.profile,
			variableNames: record.variables.map((variable) => variable.name),
			project: identity.label,
		};
	}

	async storeForProject(
		cwd: string,
		input: { profile: string; description?: string; dotenv: string },
		signal?: AbortSignal,
	): Promise<CredentialMutationResult> {
		const parsed = parseDotenvDocument(input.dotenv);
		return this.storeVariablesForProject(
			cwd,
			{ profile: input.profile, description: input.description, variables: parsed.variables, replaceExisting: true },
			signal,
		);
	}

	async prepareForMigration(
		cwd: string,
		input: { profile: string; replaceExisting?: boolean },
		signal?: AbortSignal,
	): Promise<void> {
		await this.ensureConnected(signal);
		const generation = this.connectionGeneration;
		this.assertAccessGeneration(generation);
		const profile = validateCredentialProfileName(input.profile);
		validateProjectIdentity(await this.resolveProject(cwd));
		this.assertAccessGeneration(generation);
		const summaries = await this.storage.listProfiles(signal);
		this.assertAccessGeneration(generation);
		findReplaceableProfile(summaries, profile, input.replaceExisting);
	}

	async storeVariablesForProject(
		cwd: string,
		input: { profile: string; description?: string; variables: CredentialVariable[]; replaceExisting?: boolean },
		signal?: AbortSignal,
	): Promise<CredentialMutationResult> {
		await this.ensureConnected(signal);
		const generation = this.connectionGeneration;
		this.assertAccessGeneration(generation);
		const profile = validateCredentialProfileName(input.profile);
		const description = validateCredentialDescription(input.description);
		const identity = validateProjectIdentity(await this.resolveProject(cwd));
		this.assertAccessGeneration(generation);
		const summaries = await this.storage.listProfiles(signal);
		this.assertAccessGeneration(generation);
		const existing = findReplaceableProfile(summaries, profile, input.replaceExisting);
		const existingRecord = existing
			? validateCredentialProfileRecord(await this.storage.readProfile(profile, signal))
			: undefined;
		this.assertAccessGeneration(generation);
		const projectKeys = existingRecord ? [...new Set([...existingRecord.projectKeys, identity.key])] : [identity.key];
		const record: CredentialProfileRecord = {
			profile,
			...((description ?? existingRecord?.description)
				? { description: description ?? existingRecord?.description }
				: {}),
			variables: input.variables.map((variable) => ({ name: variable.name, value: variable.value })),
			projectKeys,
		};
		validateCredentialProfileRecord(record);
		await this.storage.writeProfile(record, signal);
		this.assertAccessGeneration(generation);
		this.activate(identity.root, record);
		return {
			status: "stored",
			profile,
			variableNames: record.variables.map((variable) => variable.name),
			project: identity.label,
			portable: identity.portable,
		};
	}

	async bindProfileToProject(cwd: string, profile: string, signal?: AbortSignal): Promise<CredentialMutationResult> {
		await this.ensureConnected(signal);
		const generation = this.connectionGeneration;
		this.assertAccessGeneration(generation);
		validateCredentialProfileName(profile);
		const identity = validateProjectIdentity(await this.resolveProject(cwd));
		this.assertAccessGeneration(generation);
		const summaries = await this.storage.listProfiles(signal);
		this.assertAccessGeneration(generation);
		if (!summaries.some((summary) => summary.profile === profile)) {
			throw new CredentialManagerError("profile_not_found", "Credential profile was not found.");
		}
		const record = validateCredentialProfileRecord(await this.storage.readProfile(profile, signal));
		this.assertAccessGeneration(generation);
		if (!record.projectKeys.includes(identity.key)) record.projectKeys.push(identity.key);
		validateCredentialProfileRecord(record);
		await this.storage.writeProfile(record, signal);
		this.assertAccessGeneration(generation);
		return {
			status: "bound",
			profile,
			variableNames: record.variables.map((variable) => variable.name),
			project: identity.label,
			portable: identity.portable,
		};
	}

	async removeProfile(profile: string, signal?: AbortSignal): Promise<CredentialMutationResult> {
		await this.ensureConnected(signal);
		const generation = this.connectionGeneration;
		this.assertAccessGeneration(generation);
		validateCredentialProfileName(profile);
		const summaries = await this.storage.listProfiles(signal);
		this.assertAccessGeneration(generation);
		const summary = summaries.find((candidate) => candidate.profile === profile);
		if (!summary) throw new CredentialManagerError("profile_not_found", "Credential profile was not found.");
		await this.storage.deleteProfile(profile, signal);
		this.assertAccessGeneration(generation);
		let removedActiveEnvironment = false;
		for (const [root, active] of this.activeEnvironments) {
			if (active.profile === profile) {
				this.activeEnvironments.delete(root);
				removedActiveEnvironment = true;
			}
		}
		this.rebuildSensitiveValues();
		if (removedActiveEnvironment) this.onEnvironmentChanged();
		return { status: "removed", profile, variableNames: [...summary.variableNames] };
	}

	getEnvironmentForCwd(cwd: string): Record<string, string> | undefined {
		const target = resolve(cwd);
		const direct = this.findActiveEnvironment(target);
		const selected = direct ?? this.findActiveEnvironment(canonicalizeExistingPath(target));
		return selected ? cloneEnvironment(selected.values) : undefined;
	}

	private findActiveEnvironment(target: string): ActiveCredentialEnvironment | undefined {
		let selected: ActiveCredentialEnvironment | undefined;
		for (const active of this.activeEnvironments.values()) {
			if (!isPathInside(active.root, target)) continue;
			if (!selected || active.root.length > selected.root.length) selected = active;
		}
		return selected;
	}

	hasEnvironmentForCwd(cwd: string): boolean {
		return this.getEnvironmentForCwd(cwd) !== undefined;
	}

	redactSensitiveText(text: string): string {
		let redacted = text;
		for (const value of [...this.sensitiveValues].sort((left, right) => right.length - left.length)) {
			if (value.length > 0) redacted = redacted.split(value).join("[REDACTED_SECRET]");
		}
		return redacted;
	}

	lock(): void {
		const hadActiveEnvironment = this.activeEnvironments.size > 0;
		this.connectionGeneration++;
		this.storage.lock();
		this.connected = false;
		this.pendingSessionKey = undefined;
		this.pendingStorageProvider = undefined;
		this.sessionKeyForRedaction = undefined;
		this.connectionPromise = undefined;
		this.activeEnvironments.clear();
		this.sensitiveValues.clear();
		if (hadActiveEnvironment) this.onEnvironmentChanged();
	}

	private async ensureConnected(signal?: AbortSignal): Promise<void> {
		if (this.connected) return;
		if (this.connectionPromise) return this.connectionPromise;
		const generation = this.connectionGeneration;
		const connectionPromise = (async () => {
			let sessionKey = this.pendingSessionKey;
			let provider = this.pendingStorageProvider;
			try {
				if (!sessionKey && this.resolveMachineSession) {
					const machineSession = await this.resolveMachineSession(signal);
					if (generation !== this.connectionGeneration) {
						throw new CredentialManagerError(
							"owner_setup_required",
							"Bitwarden connection was cancelled when the owner locked credentials.",
						);
					}
					if (machineSession) {
						if (
							machineSession.provider !== "bitwarden_password_manager" &&
							machineSession.provider !== "bitwarden_secrets_manager"
						) {
							throw new CredentialManagerError("invalid_session_key", "The Bitwarden provider is invalid.");
						}
						sessionKey = validateSessionKey(machineSession.sessionKey);
						provider = machineSession.provider;
						this.pendingSessionKey = sessionKey;
						this.pendingStorageProvider = provider;
						this.sessionKeyForRedaction = sessionKey;
						this.rebuildSensitiveValues();
					}
				}
				if (!sessionKey || !provider) {
					throw new CredentialManagerError(
						"owner_setup_required",
						"No machine-owned Bitwarden session is available. Configure BWS_ACCESS_TOKEN or BW_SESSION in your environment yourself; Pi never prompts.",
					);
				}
				await this.storage.connect(sessionKey, signal, provider);
				if (generation !== this.connectionGeneration) {
					this.storage.lock();
					throw new CredentialManagerError(
						"owner_setup_required",
						"Bitwarden connection was cancelled when the owner locked credentials.",
					);
				}
				this.connected = true;
			} finally {
				if (generation === this.connectionGeneration) {
					this.pendingSessionKey = undefined;
					this.pendingStorageProvider = undefined;
				}
				if (sessionKey) sessionKey = "";
			}
		})();
		this.connectionPromise = connectionPromise;
		try {
			await connectionPromise;
		} finally {
			if (this.connectionPromise === connectionPromise) this.connectionPromise = undefined;
		}
	}

	private assertAccessGeneration(generation: number): void {
		if (generation === this.connectionGeneration && this.connected) return;
		throw new CredentialManagerError(
			"owner_setup_required",
			"Bitwarden credential access was cancelled when the owner locked credentials.",
		);
	}

	private async refreshProjectProfiles(
		cwd: string,
		signal?: AbortSignal,
	): Promise<{
		generation: number;
		identity: CredentialProjectIdentity;
		summaries: StoredCredentialProfileSummary[];
	}> {
		await this.ensureConnected(signal);
		const generation = this.connectionGeneration;
		this.assertAccessGeneration(generation);
		await this.storage.refresh?.(signal);
		this.assertAccessGeneration(generation);
		const identity = validateProjectIdentity(await this.resolveProject(cwd));
		this.assertAccessGeneration(generation);
		const summaries = await this.storage.listProfiles(signal);
		this.assertAccessGeneration(generation);
		return { generation, identity, summaries };
	}

	private activate(root: string, record: CredentialProfileRecord): void {
		const values = Object.fromEntries(record.variables.map((variable) => [variable.name, variable.value]));
		this.activeEnvironments.set(resolve(root), { profile: record.profile, root: resolve(root), values });
		this.rebuildSensitiveValues();
		this.onEnvironmentChanged();
	}

	private rebuildSensitiveValues(): void {
		this.sensitiveValues.clear();
		if (this.sessionKeyForRedaction) this.sensitiveValues.add(this.sessionKeyForRedaction);
		for (const active of this.activeEnvironments.values()) {
			for (const value of Object.values(active.values)) this.sensitiveValues.add(value);
		}
	}
}

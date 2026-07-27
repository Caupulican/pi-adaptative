import { createHash } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { managedSecretEnvDir, secretsDir, secretVaultFile } from "../agent-paths.ts";
import { redactKnownSecrets } from "../security/secret-text.ts";
import { withFileLock, writeFileAtomic } from "../util/atomic-file.ts";
import { MAX_DOTENV_DOCUMENT_BYTES, parseDotenvDocument } from "./secret-dotenv.ts";
import {
	assertPassphrase,
	createVaultKdf,
	DEFAULT_SCRYPT_N,
	decryptPayload,
	deriveKey,
	MANAGED_ENV_HEADER_PREFIX,
	MAX_BINDINGS_PER_PROFILE,
	MAX_PROFILES,
	MAX_VARIABLES_PER_PROFILE,
	MAX_VAULT_FILE_BYTES,
	parseEnvelope,
	profileSummary,
	type SecretBindingResolution,
	type SecretBindingSummary,
	type SecretEnvDestinationState,
	type SecretMaterializationResult,
	type SecretProfileSummary,
	type SecretRemovalResult,
	type SecretVariableValue,
	SecretVaultError,
	type SecretVaultOptions,
	sameKdf,
	scrubPayload,
	serializeEnvelope,
	serializeVariableValues,
	VAULT_MARKER,
	type VaultKdf,
	type VaultPayload,
	validateBindingEnvFile,
	validateBindingWorkspace,
	validateDescription,
	validateDotenvProfileDocument,
	validateProfileId,
	validateScryptN,
	validateSecretValue,
	validateVariableName,
} from "./secret-vault-format.ts";

export type {
	SecretBindingResolution,
	SecretBindingSummary,
	SecretEnvDestinationState,
	SecretMaterializationResult,
	SecretProfileSummary,
	SecretRemovalResult,
	SecretVariableValue,
	SecretVaultErrorCode,
	SecretVaultOptions,
} from "./secret-vault-format.ts";
export {
	MAX_BINDINGS_PER_PROFILE,
	MAX_VARIABLES_PER_PROFILE,
	SECRET_DESCRIPTION_MAX_CHARS,
	SECRET_PRINTABLE_METADATA_PATTERN,
	SECRET_PROFILE_ID_MAX_CHARS,
	SECRET_PROFILE_ID_PATTERN,
	SECRET_VARIABLE_NAME_MAX_CHARS,
	SECRET_VARIABLE_NAME_PATTERN,
	SecretVaultError,
} from "./secret-vault-format.ts";

function nodeErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

async function lstatIfExists(path: string): Promise<Stats | undefined> {
	try {
		return await fs.lstat(path);
	} catch (error) {
		if (nodeErrorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

async function readBoundedRegularFile(
	filePath: string,
	maxBytes: number,
	label: "Secret vault" | "Dotenv file",
): Promise<string> {
	const before = await fs.lstat(filePath);
	if (before.isSymbolicLink()) throw new SecretVaultError("symlink_refused", `${label} symlinks are refused.`);
	if (!before.isFile()) {
		throw new SecretVaultError(
			label === "Secret vault" ? "vault_corrupt" : "destination_invalid",
			`${label} path is not a regular file.`,
		);
	}
	if (before.size > maxBytes) {
		throw new SecretVaultError(
			label === "Secret vault" ? "vault_too_large" : "invalid_dotenv",
			`${label} exceeds its ${label === "Secret vault" ? "4 MiB" : "512 KiB"} limit.`,
		);
	}
	const handle = await fs.open(filePath, constants.O_RDONLY);
	try {
		const opened = await handle.stat();
		if ((before.dev !== opened.dev || before.ino !== opened.ino) && before.ino !== 0 && opened.ino !== 0) {
			throw new SecretVaultError("symlink_refused", "Secret vault changed while it was being opened.");
		}
		const output = Buffer.alloc(Math.min(maxBytes + 1, before.size + 1));
		let offset = 0;
		while (offset < output.byteLength) {
			const { bytesRead } = await handle.read(output, offset, output.byteLength - offset, null);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset > before.size || offset > maxBytes) {
			output.fill(0);
			throw new SecretVaultError(
				label === "Secret vault" ? "vault_too_large" : "invalid_dotenv",
				`${label} grew beyond its limit while being read.`,
			);
		}
		const text = output.toString("utf8", 0, offset);
		output.fill(0);
		return text;
	} finally {
		await handle.close();
	}
}

async function readBoundedFile(filePath: string): Promise<string> {
	return readBoundedRegularFile(filePath, MAX_VAULT_FILE_BYTES, "Secret vault");
}

async function readFilePrefix(filePath: string, maxBytes: number): Promise<string> {
	const handle = await fs.open(filePath, constants.O_RDONLY);
	try {
		const output = Buffer.alloc(maxBytes);
		const { bytesRead } = await handle.read(output, 0, output.byteLength, 0);
		const text = output.toString("utf8", 0, bytesRead);
		output.fill(0);
		return text;
	} finally {
		await handle.close();
	}
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	const existing = await lstatIfExists(path);
	if (existing?.isSymbolicLink()) {
		throw new SecretVaultError("symlink_refused", "Secret storage directory symlinks are refused.");
	}
	if (existing && !existing.isDirectory()) {
		throw new SecretVaultError("destination_invalid", "Secret storage path is not a directory.");
	}
	await fs.mkdir(path, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") await fs.chmod(path, 0o700);
}

async function enforcePrivateFileMode(path: string): Promise<void> {
	if (process.platform !== "win32") await fs.chmod(path, 0o600);
}

interface CachedSecretVariable {
	name: string;
	value: string;
}

interface CachedSecretProfile {
	profile: string;
	bindings: SecretBindingSummary[];
	variables: CachedSecretVariable[];
}

function isPathInside(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Encrypted generic credential vault. Only the derived key is retained in memory, until this
 * process explicitly locks the vault or exits. The native model-facing tool receives summaries,
 * never decrypted values or materialization paths.
 */
export class SecretVault {
	readonly vaultPath: string;
	readonly materializedDir: string;
	private readonly rootDir: string;
	private readonly scryptN: number;
	private readonly now: () => Date;
	private readonly onEnvironmentChanged: (() => void) | undefined;
	private cachedKey: Buffer | undefined;
	private cachedKdf: VaultKdf | undefined;
	private cachedProfiles: CachedSecretProfile[] = [];
	private readonly activeProfilesByWorkspace = new Map<string, string>();

	constructor(options: SecretVaultOptions) {
		this.rootDir = secretsDir(options.agentDir);
		this.vaultPath = secretVaultFile(options.agentDir);
		this.materializedDir = managedSecretEnvDir(options.agentDir);
		this.scryptN = validateScryptN(options.scryptN ?? DEFAULT_SCRYPT_N);
		this.now = options.now ?? (() => new Date());
		this.onEnvironmentChanged = options.onEnvironmentChanged;
	}

	static forAgentDir(agentDir: string): SecretVault {
		return new SecretVault({ agentDir });
	}

	get isUnlocked(): boolean {
		return this.cachedKey !== undefined;
	}

	async exists(): Promise<boolean> {
		const existing = await lstatIfExists(this.vaultPath);
		if (existing?.isSymbolicLink()) {
			throw new SecretVaultError("symlink_refused", "Secret vault symlinks are refused.");
		}
		return existing !== undefined;
	}

	lock(): void {
		this.cachedKey?.fill(0);
		this.cachedKey = undefined;
		this.cachedKdf = undefined;
		this.clearSecretCache();
		this.activeProfilesByWorkspace.clear();
		this.notifyEnvironmentChanged();
	}

	/** Environment for the nearest explicitly activated profile covering cwd. */
	getEnvironmentForCwd(cwd: string): NodeJS.ProcessEnv {
		const match = this.resolveCachedProfile(cwd);
		if (!match) return {};
		return Object.fromEntries(match.profile.variables.map((variable) => [variable.name, variable.value]));
	}

	hasEnvironmentForCwd(cwd: string): boolean {
		return this.resolveCachedProfile(cwd) !== undefined;
	}

	/** Remove exact unlocked vault values and high-confidence credential shapes from model-facing text. */
	redactSensitiveText(text: string): string {
		let redacted = redactKnownSecrets(text);
		const values = [
			...new Set(
				this.cachedProfiles
					.flatMap((profile) => profile.variables.map((variable) => variable.value))
					.filter(Boolean),
			),
		].sort((left, right) => right.length - left.length);
		for (const value of values) {
			if (value.length >= 4) {
				redacted = redacted.split(value).join("[REDACTED]");
				continue;
			}
			const bounded = new RegExp(`(^|[\\s=:;,])${escapeRegExp(value)}(?=$|[\\s,;])`, "g");
			redacted = redacted.replace(bounded, (_match, prefix: string) => `${prefix}[REDACTED]`);
		}
		return redacted;
	}

	async initialize(passphrase: string): Promise<void> {
		assertPassphrase(passphrase, true);
		await ensurePrivateDirectory(this.rootDir);
		await withFileLock(this.vaultPath, async () => {
			if (await lstatIfExists(this.vaultPath)) {
				throw new SecretVaultError("already_initialized", "Secret vault is already initialized.");
			}
			const kdf = createVaultKdf(this.scryptN);
			const key = await deriveKey(passphrase, kdf);
			const payload: VaultPayload = { marker: VAULT_MARKER, profiles: [] };
			try {
				await this.writeEnvelope(kdf, payload, key);
				this.replaceCachedKey(key, kdf);
			} catch (error) {
				key.fill(0);
				throw error;
			}
		});
	}

	async unlock(passphrase: string): Promise<void> {
		assertPassphrase(passphrase, false);
		if (!(await this.exists())) throw new SecretVaultError("not_initialized", "Secret vault is not initialized.");
		const envelope = parseEnvelope(await readBoundedFile(this.vaultPath));
		const key = await deriveKey(passphrase, envelope.kdf);
		let payload: VaultPayload | undefined;
		try {
			const environmentBefore = this.activeEnvironmentFingerprint();
			payload = decryptPayload(envelope.payload, key);
			this.replaceCachedKey(key, envelope.kdf);
			this.refreshSecretCache(payload);
			if (environmentBefore !== this.activeEnvironmentFingerprint()) this.notifyEnvironmentChanged();
		} catch (error) {
			key.fill(0);
			throw error;
		} finally {
			if (payload) scrubPayload(payload);
		}
	}

	async listProfiles(): Promise<SecretProfileSummary[]> {
		return this.withPayload((payload) => payload.profiles.map(profileSummary), false);
	}

	async upsertProfile(
		profile: string,
		description: string | undefined,
		values: readonly SecretVariableValue[],
	): Promise<SecretProfileSummary> {
		if (values.length === 0) {
			throw new SecretVaultError("invalid_variable", "At least one environment variable is required.");
		}
		const seenNames = new Set<string>();
		const normalizedValues = values.map((entry) => {
			const name = validateVariableName(entry.name);
			if (seenNames.has(name)) {
				throw new SecretVaultError("invalid_variable", `Environment variable ${name} is duplicated.`);
			}
			seenNames.add(name);
			return { name, value: validateSecretValue(entry.value) };
		});
		return this.storeProfileDocument(
			profile,
			description,
			serializeVariableValues(normalizedValues),
			undefined,
			true,
		);
	}

	async replaceProfileDocument(
		profile: string,
		description: string | undefined,
		document: string,
		binding?: { workspace: string; envFile: string },
	): Promise<SecretProfileSummary> {
		return this.storeProfileDocument(profile, description, document, binding, false);
	}

	async getProfileDocument(profile: string): Promise<string | undefined> {
		const normalizedProfile = validateProfileId(profile);
		return this.withPayload(
			(payload) => payload.profiles.find((candidate) => candidate.profile === normalizedProfile)?.dotenv,
			false,
		);
	}

	async readOwnerDotenv(destination: string): Promise<string> {
		this.assertDestination(destination);
		return readBoundedRegularFile(destination, MAX_DOTENV_DOCUMENT_BYTES, "Dotenv file");
	}

	async removeProfile(profile: string, variableNames?: readonly string[]): Promise<SecretRemovalResult> {
		const normalizedProfile = validateProfileId(profile);
		const normalizedNames = variableNames?.map(validateVariableName);
		if (normalizedNames && new Set(normalizedNames).size !== normalizedNames.length) {
			throw new SecretVaultError("invalid_variable", "Environment variable removals are duplicated.");
		}
		let managedMaterializationRemoved = false;
		let boundMaterializationsRemoved = 0;
		const result = await this.withPayload(async (payload) => {
			const index = payload.profiles.findIndex((candidate) => candidate.profile === normalizedProfile);
			const record = payload.profiles[index];
			if (!record) throw new SecretVaultError("profile_missing", "Secret profile does not exist.");
			const variables = validateDotenvProfileDocument(record.dotenv).variables;
			let removedProfile: boolean;
			let removedVariableNames: string[];
			let remaining: SecretVariableValue[] = [];
			if (normalizedNames === undefined) {
				removedProfile = true;
				removedVariableNames = variables.map((variable) => variable.name);
			} else {
				if (normalizedNames.length === 0) {
					throw new SecretVaultError("invalid_variable", "Select at least one environment variable to remove.");
				}
				const requested = new Set(normalizedNames);
				removedVariableNames = variables
					.filter((variable) => requested.has(variable.name))
					.map((variable) => variable.name);
				if (removedVariableNames.length !== requested.size) {
					throw new SecretVaultError(
						"invalid_variable",
						"One or more requested environment variables do not exist.",
					);
				}
				remaining = variables.filter((variable) => !requested.has(variable.name));
				removedProfile = remaining.length === 0;
			}

			// Validate the complete mutation before removing any recoverable materialization.
			managedMaterializationRemoved = await this.removeManagedMaterialization(normalizedProfile);
			boundMaterializationsRemoved = await this.removeBoundMaterializations(record);
			if (removedProfile) payload.profiles.splice(index, 1);
			else {
				record.dotenv = serializeVariableValues(remaining);
				record.updatedAt = this.now().toISOString();
			}
			return { removedProfile, removedVariableNames };
		}, true);
		this.deactivateProfile(normalizedProfile);
		return {
			profile: normalizedProfile,
			...result,
			managedMaterializationRemoved,
			boundMaterializationsRemoved,
		};
	}

	getManagedEnvPath(profile: string): string {
		return join(this.materializedDir, `${validateProfileId(profile)}.env`);
	}

	resolveBindingTarget(
		workspace: string,
		envFile: string,
	): {
		workspace: string;
		envFile: string;
		destination: string;
	} {
		const normalizedWorkspace = validateBindingWorkspace(resolve(workspace));
		const normalizedEnvFile = validateBindingEnvFile(envFile);
		const destination = resolve(normalizedWorkspace, normalizedEnvFile);
		if (!isPathInside(normalizedWorkspace, destination)) {
			throw new SecretVaultError("destination_invalid", "Credential target must stay inside its workspace.");
		}
		return { workspace: normalizedWorkspace, envFile: normalizedEnvFile, destination };
	}

	async resolveBindingForWorkspace(cwd: string, profile?: string): Promise<SecretBindingResolution> {
		const normalizedCwd = resolve(cwd);
		const normalizedProfile = profile === undefined ? undefined : validateProfileId(profile);
		return this.withPayload((payload) => {
			const matches = payload.profiles.flatMap((candidate) => {
				if (normalizedProfile !== undefined && candidate.profile !== normalizedProfile) return [];
				const binding = candidate.bindings
					.filter((entry) => isPathInside(entry.workspace, normalizedCwd))
					.sort((left, right) => right.workspace.length - left.workspace.length)[0];
				if (!binding) return [];
				return [{ candidate, binding }];
			});
			if (matches.length === 0) {
				throw new SecretVaultError(
					"binding_missing",
					normalizedProfile
						? `Secret profile ${normalizedProfile} is not bound to this workspace.`
						: "No secret profile is bound to this workspace.",
				);
			}
			const longestRoot = Math.max(...matches.map((match) => match.binding.workspace.length));
			const nearest = matches.filter((match) => match.binding.workspace.length === longestRoot);
			let selected = nearest[0];
			if (nearest.length > 1) {
				const active = nearest.find(
					(match) => this.activeProfilesByWorkspace.get(match.binding.workspace) === match.candidate.profile,
				);
				if (!active) {
					throw new SecretVaultError(
						"ambiguous_binding",
						"Multiple secret profiles apply to this workspace; select one by profile name.",
					);
				}
				selected = active;
			}
			const parsed = validateDotenvProfileDocument(selected.candidate.dotenv);
			return {
				profile: selected.candidate.profile,
				...selected.binding,
				destination: resolve(selected.binding.workspace, selected.binding.envFile),
				variableNames: parsed.variables.map((variable) => variable.name),
			};
		}, false);
	}

	async inspectEnvDestination(destination: string, profile: string): Promise<SecretEnvDestinationState> {
		validateProfileId(profile);
		this.assertDestination(destination);
		const existing = await lstatIfExists(destination);
		if (!existing) return "missing";
		if (existing.isSymbolicLink()) {
			throw new SecretVaultError("symlink_refused", "Secret dotenv destination symlinks are refused.");
		}
		if (!existing.isFile()) {
			throw new SecretVaultError("destination_invalid", "Secret dotenv destination is not a regular file.");
		}
		const firstLine = (await readFilePrefix(destination, 512)).split(/\r?\n/, 1)[0] ?? "";
		if (firstLine === `${MANAGED_ENV_HEADER_PREFIX}${profile}`) return "managed-profile";
		if (firstLine.startsWith(MANAGED_ENV_HEADER_PREFIX)) return "managed-other";
		return "unmanaged";
	}

	async materializeEnv(
		profile: string,
		destination: string,
		options: {
			activationWorkspace?: string;
			allowReplaceUnmanaged?: boolean;
			expectedUnmanagedContent?: string;
			managed?: boolean;
		} = {},
	): Promise<SecretMaterializationResult> {
		const normalizedProfile = validateProfileId(profile);
		this.assertDestination(destination);
		const previousState = await this.inspectEnvDestination(destination, normalizedProfile);
		await this.assertReplaceableDestination(destination, previousState, options);
		if (options.managed) {
			if (resolve(destination) !== resolve(this.getManagedEnvPath(normalizedProfile))) {
				throw new SecretVaultError("destination_invalid", "Managed dotenv destination is not canonical.");
			}
			await ensurePrivateDirectory(this.materializedDir);
		} else {
			const parent = await lstatIfExists(dirname(destination));
			if (!parent?.isDirectory()) {
				throw new SecretVaultError("destination_invalid", "Dotenv destination directory does not exist.");
			}
		}
		return this.withPayload(async (payload) => {
			const record = payload.profiles.find((candidate) => candidate.profile === normalizedProfile);
			if (!record) throw new SecretVaultError("profile_missing", "Secret profile does not exist.");
			const binding = record.bindings.find(
				(candidate) => resolve(candidate.workspace, candidate.envFile) === resolve(destination),
			);
			const activationCwd = options.activationWorkspace ? resolve(options.activationWorkspace) : undefined;
			const activationBinding = activationCwd
				? record.bindings
						.filter((candidate) => isPathInside(candidate.workspace, activationCwd))
						.sort((left, right) => right.workspace.length - left.workspace.length)[0]
				: binding;
			if (activationCwd && !activationBinding) {
				throw new SecretVaultError(
					"binding_missing",
					`Secret profile ${normalizedProfile} is not bound to this workspace.`,
				);
			}
			if (binding && !options.managed) await this.assertBoundDestinationParent(binding, destination);
			const currentState = await this.inspectEnvDestination(destination, normalizedProfile);
			await this.assertReplaceableDestination(destination, currentState, options);
			const variableNames = validateDotenvProfileDocument(record.dotenv).variables.map((variable) => variable.name);
			const body = record.dotenv.endsWith("\n") ? record.dotenv : `${record.dotenv}\n`;
			let dotenv = `${MANAGED_ENV_HEADER_PREFIX}${normalizedProfile}\n# Generated by Pi. Do not edit, inspect, source as shell code, or commit.\n${body}`;
			try {
				await writeFileAtomic(destination, dotenv, { mode: 0o600 });
				await enforcePrivateFileMode(destination);
				if (activationBinding) {
					this.activeProfilesByWorkspace.set(activationBinding.workspace, normalizedProfile);
				}
			} finally {
				dotenv = "";
			}
			return { profile: normalizedProfile, variableNames, previousState: currentState };
		}, false);
	}

	private async storeProfileDocument(
		profile: string,
		description: string | undefined,
		document: string,
		binding: { workspace: string; envFile: string } | undefined,
		merge: boolean,
	): Promise<SecretProfileSummary> {
		const normalizedProfile = validateProfileId(profile);
		const normalizedDescription = validateDescription(description);
		const parsedDocument = validateDotenvProfileDocument(document);
		const target = binding ? this.resolveBindingTarget(binding.workspace, binding.envFile) : undefined;
		const normalizedBinding = target ? { workspace: target.workspace, envFile: target.envFile } : undefined;

		const summary = await this.withPayload(async (payload) => {
			let record = payload.profiles.find((candidate) => candidate.profile === normalizedProfile);
			const timestamp = this.now().toISOString();
			if (!record && payload.profiles.length >= MAX_PROFILES) {
				throw new SecretVaultError("profile_limit", `Secret vault supports at most ${MAX_PROFILES} profiles.`);
			}
			const nextBindings = record?.bindings.map((entry) => ({ ...entry })) ?? [];
			if (normalizedBinding) {
				const next = { ...normalizedBinding, updatedAt: timestamp };
				const existingIndex = nextBindings.findIndex((entry) => entry.workspace === normalizedBinding.workspace);
				if (existingIndex === -1) nextBindings.push(next);
				else nextBindings[existingIndex] = next;
				if (nextBindings.length > MAX_BINDINGS_PER_PROFILE) {
					throw new SecretVaultError(
						"profile_limit",
						`A secret profile supports at most ${MAX_BINDINGS_PER_PROFILE} workspace bindings.`,
					);
				}
			}

			let nextDocument = parsedDocument.document;
			if (merge && record) {
				const merged = new Map(
					validateDotenvProfileDocument(record.dotenv).variables.map((variable) => [
						variable.name,
						variable.value,
					]),
				);
				for (const variable of parsedDocument.variables) merged.set(variable.name, variable.value);
				if (merged.size > MAX_VARIABLES_PER_PROFILE) {
					throw new SecretVaultError(
						"variable_limit",
						`A secret profile supports at most ${MAX_VARIABLES_PER_PROFILE} variables.`,
					);
				}
				nextDocument = serializeVariableValues([...merged].map(([name, value]) => ({ name, value })));
			}

			if (record) {
				await this.removeManagedMaterialization(normalizedProfile);
				await this.removeBoundMaterializations(record);
			} else {
				record = {
					profile: normalizedProfile,
					createdAt: timestamp,
					updatedAt: timestamp,
					dotenv: nextDocument,
					bindings: [],
				};
				payload.profiles.push(record);
			}
			if (normalizedDescription !== undefined) record.description = normalizedDescription;
			record.dotenv = nextDocument;
			record.bindings = nextBindings.sort(
				(left, right) => left.workspace.localeCompare(right.workspace) || left.envFile.localeCompare(right.envFile),
			);
			record.updatedAt = timestamp;
			payload.profiles.sort((left, right) => left.profile.localeCompare(right.profile));
			return profileSummary(record);
		}, true);
		this.deactivateProfile(normalizedProfile);
		return summary;
	}

	private async assertReplaceableDestination(
		destination: string,
		state: SecretEnvDestinationState,
		options: { allowReplaceUnmanaged?: boolean; expectedUnmanagedContent?: string },
	): Promise<void> {
		if (state === "managed-other") {
			throw new SecretVaultError(
				"destination_conflict",
				"Destination already contains a file managed for another secret profile.",
			);
		}
		if (state !== "unmanaged") return;
		if (!options.allowReplaceUnmanaged || options.expectedUnmanagedContent === undefined) {
			throw new SecretVaultError(
				"destination_conflict",
				"Destination already contains an unmanaged file that was not reviewed for replacement.",
			);
		}
		if ((await this.readOwnerDotenv(destination)) !== options.expectedUnmanagedContent) {
			throw new SecretVaultError(
				"destination_conflict",
				"The reviewed dotenv file changed before replacement and was preserved.",
			);
		}
	}

	private async assertBoundDestinationParent(binding: SecretBindingSummary, destination: string): Promise<void> {
		try {
			const [workspace, parent] = await Promise.all([
				fs.realpath(binding.workspace),
				fs.realpath(dirname(destination)),
			]);
			if (isPathInside(workspace, parent)) return;
		} catch {
			// Collapse filesystem detail so a model-facing failure cannot disclose unrelated paths.
		}
		throw new SecretVaultError(
			"destination_invalid",
			"Credential destination resolves outside its bound workspace or cannot be verified.",
		);
	}

	private assertDestination(destination: string): void {
		if (!isAbsolute(destination) || resolve(destination) === resolve(this.vaultPath)) {
			throw new SecretVaultError(
				"destination_invalid",
				"Secret dotenv destination must be an absolute non-vault path.",
			);
		}
	}

	private replaceCachedKey(key: Buffer, kdf: VaultKdf): void {
		this.cachedKey?.fill(0);
		this.cachedKey = key;
		this.cachedKdf = { ...kdf };
	}

	private clearSecretCache(): void {
		for (const profile of this.cachedProfiles) {
			for (const variable of profile.variables) variable.value = "";
		}
		this.cachedProfiles = [];
	}

	private deactivateProfile(profile: string): void {
		let changed = false;
		for (const [workspace, activeProfile] of this.activeProfilesByWorkspace) {
			if (activeProfile !== profile) continue;
			this.activeProfilesByWorkspace.delete(workspace);
			changed = true;
		}
		const cached = this.cachedProfiles.find((candidate) => candidate.profile === profile);
		if (cached) {
			for (const variable of cached.variables) variable.value = "";
			cached.variables = [];
		}
		if (changed) this.notifyEnvironmentChanged();
	}

	private notifyEnvironmentChanged(): void {
		try {
			this.onEnvironmentChanged?.();
		} catch {
			// Credential state changes remain authoritative even if host cleanup is best-effort.
		}
	}

	private activeEnvironmentFingerprint(): string {
		const hash = createHash("sha256");
		for (const profile of this.cachedProfiles) {
			const activeBindings = profile.bindings
				.filter((binding) => this.activeProfilesByWorkspace.get(binding.workspace) === profile.profile)
				.sort((left, right) => left.workspace.localeCompare(right.workspace));
			if (activeBindings.length === 0) continue;
			hash.update(`${profile.profile.length}:${profile.profile}`);
			for (const binding of activeBindings) hash.update(`${binding.workspace.length}:${binding.workspace}`);
			for (const variable of profile.variables) {
				hash.update(`${variable.name.length}:${variable.name}${variable.value.length}:${variable.value}`);
			}
		}
		return hash.digest("hex");
	}

	private refreshSecretCache(payload: VaultPayload): void {
		this.clearSecretCache();
		this.cachedProfiles = payload.profiles.map((profile) => ({
			profile: profile.profile,
			bindings: profile.bindings.map((binding) => ({ ...binding })),
			variables: profile.bindings.some(
				(binding) => this.activeProfilesByWorkspace.get(binding.workspace) === profile.profile,
			)
				? parseDotenvDocument(profile.dotenv).variables.map((variable) => ({ ...variable }))
				: [],
		}));
		for (const [workspace, profile] of this.activeProfilesByWorkspace) {
			const stillBound = this.cachedProfiles.some(
				(candidate) =>
					candidate.profile === profile && candidate.bindings.some((binding) => binding.workspace === workspace),
			);
			if (!stillBound) this.activeProfilesByWorkspace.delete(workspace);
		}
	}

	private resolveCachedProfile(
		cwd: string,
	): { profile: CachedSecretProfile; binding: SecretBindingSummary } | undefined {
		const resolvedCwd = resolve(cwd);
		return this.cachedProfiles
			.flatMap((profile) => {
				const binding = profile.bindings
					.filter((candidate) => isPathInside(candidate.workspace, resolvedCwd))
					.sort((left, right) => right.workspace.length - left.workspace.length)[0];
				return binding ? [{ profile, binding }] : [];
			})
			.filter((match) => this.activeProfilesByWorkspace.get(match.binding.workspace) === match.profile.profile)
			.sort((left, right) => right.binding.workspace.length - left.binding.workspace.length)[0];
	}

	private requireUnlocked(): { key: Buffer; kdf: VaultKdf } {
		if (!this.cachedKey || !this.cachedKdf) {
			throw new SecretVaultError("not_unlocked", "Secret vault is locked.");
		}
		return { key: this.cachedKey, kdf: this.cachedKdf };
	}

	private async withPayload<T>(operation: (payload: VaultPayload) => T | Promise<T>, write: boolean): Promise<T> {
		return withFileLock(this.vaultPath, async () => {
			const environmentBefore = this.activeEnvironmentFingerprint();
			const { key, kdf } = this.requireUnlocked();
			if (!(await lstatIfExists(this.vaultPath))) {
				throw new SecretVaultError("not_initialized", "Secret vault is not initialized.");
			}
			const envelope = parseEnvelope(await readBoundedFile(this.vaultPath));
			if (!sameKdf(kdf, envelope.kdf)) {
				this.lock();
				throw new SecretVaultError("unlock_failed", "Secret vault changed and must be unlocked again.");
			}
			const payload = decryptPayload(envelope.payload, key);
			try {
				const result = await operation(payload);
				if (write) await this.writeEnvelope(kdf, payload, key);
				this.refreshSecretCache(payload);
				if (environmentBefore !== this.activeEnvironmentFingerprint()) this.notifyEnvironmentChanged();
				return result;
			} finally {
				scrubPayload(payload);
			}
		});
	}

	private async writeEnvelope(kdf: VaultKdf, payload: VaultPayload, key: Buffer): Promise<void> {
		let serialized = serializeEnvelope(kdf, payload, key);
		try {
			await writeFileAtomic(this.vaultPath, serialized, { mode: 0o600 });
			await enforcePrivateFileMode(this.vaultPath);
		} finally {
			serialized = "";
		}
	}

	private async removeBoundMaterializations(record: {
		profile: string;
		bindings: SecretBindingSummary[];
	}): Promise<number> {
		let removed = 0;
		for (const binding of record.bindings) {
			const destination = resolve(binding.workspace, binding.envFile);
			const existing = await lstatIfExists(destination);
			if (!existing) continue;
			const state = await this.inspectEnvDestination(destination, record.profile);
			if (state !== "managed-profile") continue;
			await fs.unlink(destination);
			removed++;
		}
		return removed;
	}

	private async removeManagedMaterialization(profile: string): Promise<boolean> {
		const path = this.getManagedEnvPath(profile);
		const existing = await lstatIfExists(path);
		if (!existing) return false;
		if (existing.isSymbolicLink()) {
			throw new SecretVaultError("symlink_refused", "Managed dotenv symlinks are refused.");
		}
		if (!existing.isFile()) {
			throw new SecretVaultError("destination_invalid", "Managed dotenv path is not a regular file.");
		}
		const state = await this.inspectEnvDestination(path, profile);
		if (state !== "managed-profile") return false;
		await fs.unlink(path);
		return true;
	}
}

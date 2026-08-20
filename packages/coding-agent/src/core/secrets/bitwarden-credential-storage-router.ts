import { BitwardenCredentialStorage } from "./bitwarden-credential-storage.ts";
import { BitwardenSecretsManagerCredentialStorage } from "./bitwarden-secrets-manager-storage.ts";
import {
	type CredentialProfileRecord,
	type CredentialProfileStorage,
	CredentialStorageError,
	type CredentialStorageProvider,
	type StoredCredentialProfileSummary,
} from "./credential-manager.ts";

export interface BitwardenCredentialStorageRouterOptions {
	passwordManager?: CredentialProfileStorage;
	secretsManager?: CredentialProfileStorage;
	secretsManagerCoordinationFile?: string;
}

/** Provider strategy owner selected once by CredentialManager's validated machine session. */
export class BitwardenCredentialStorageRouter implements CredentialProfileStorage {
	private readonly passwordManager: CredentialProfileStorage;
	private readonly secretsManager: CredentialProfileStorage;
	private active: CredentialProfileStorage | undefined;

	constructor(options: BitwardenCredentialStorageRouterOptions) {
		this.passwordManager = options.passwordManager ?? new BitwardenCredentialStorage();
		if (options.secretsManager) {
			this.secretsManager = options.secretsManager;
		} else {
			if (!options.secretsManagerCoordinationFile) {
				throw new TypeError("Bitwarden Secrets Manager requires a coordination file.");
			}
			this.secretsManager = new BitwardenSecretsManagerCredentialStorage({
				coordinationFile: options.secretsManagerCoordinationFile,
			});
		}
	}

	async connect(
		sessionKey: string,
		signal?: AbortSignal,
		provider: CredentialStorageProvider = "bitwarden_password_manager",
	): Promise<void> {
		this.lock();
		const selected = provider === "bitwarden_secrets_manager" ? this.secretsManager : this.passwordManager;
		this.active = selected;
		try {
			await selected.connect(sessionKey, signal, provider);
		} catch (error) {
			selected.lock();
			this.active = undefined;
			throw error;
		}
	}

	async refresh(signal?: AbortSignal): Promise<void> {
		await this.requireActive().refresh?.(signal);
	}

	async listProfiles(signal?: AbortSignal): Promise<StoredCredentialProfileSummary[]> {
		return this.requireActive().listProfiles(signal);
	}

	async readProfile(profile: string, signal?: AbortSignal): Promise<CredentialProfileRecord> {
		return this.requireActive().readProfile(profile, signal);
	}

	async writeProfile(record: CredentialProfileRecord, signal?: AbortSignal): Promise<void> {
		await this.requireActive().writeProfile(record, signal);
	}

	async deleteProfile(profile: string, signal?: AbortSignal): Promise<void> {
		await this.requireActive().deleteProfile(profile, signal);
	}

	lock(): void {
		this.passwordManager.lock();
		this.secretsManager.lock();
		this.active = undefined;
	}

	private requireActive(): CredentialProfileStorage {
		if (!this.active) throw new CredentialStorageError("not_connected", "Bitwarden is not connected.");
		return this.active;
	}
}

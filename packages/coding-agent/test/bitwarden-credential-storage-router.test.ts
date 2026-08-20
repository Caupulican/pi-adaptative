import { describe, expect, it, vi } from "vitest";
import { BitwardenCredentialStorageRouter } from "../src/core/secrets/bitwarden-credential-storage-router.ts";
import type {
	CredentialProfileRecord,
	CredentialProfileStorage,
	CredentialStorageProvider,
} from "../src/core/secrets/credential-manager.ts";

function storage() {
	const connect = vi.fn(async () => {});
	const adapter: CredentialProfileStorage = {
		connect,
		listProfiles: vi.fn(async () => []),
		readProfile: vi.fn(async () => {
			throw new Error("unused");
		}),
		writeProfile: vi.fn(async (_record: CredentialProfileRecord) => {}),
		deleteProfile: vi.fn(async () => {}),
		lock: vi.fn(),
	};
	return { adapter, connect };
}

describe("BitwardenCredentialStorageRouter", () => {
	it.each([
		["bitwarden_password_manager", "passwordManager"],
		["bitwarden_secrets_manager", "secretsManager"],
	] as const)("routes %s through its one provider adapter", async (provider, selected) => {
		const passwordManager = storage();
		const secretsManager = storage();
		const router = new BitwardenCredentialStorageRouter({
			passwordManager: passwordManager.adapter,
			secretsManager: secretsManager.adapter,
		});

		await router.connect("private-session", undefined, provider satisfies CredentialStorageProvider);
		await router.listProfiles();

		const expected = selected === "passwordManager" ? passwordManager : secretsManager;
		const rejected = selected === "passwordManager" ? secretsManager : passwordManager;
		expect(expected.connect).toHaveBeenCalledWith("private-session", undefined, provider);
		expect(expected.adapter.listProfiles).toHaveBeenCalledOnce();
		expect(rejected.connect).not.toHaveBeenCalled();
	});
});

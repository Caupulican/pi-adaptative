import { describe, expect, it, vi } from "vitest";
import {
	CredentialManager,
	CredentialManagerError,
	type CredentialProfileRecord,
	type CredentialProfileStorage,
	type CredentialProjectIdentity,
} from "../src/core/secrets/credential-manager.ts";

class MemoryCredentialStorage implements CredentialProfileStorage {
	readonly connectCalls: string[] = [];
	readonly readCalls: string[] = [];
	readonly records = new Map<string, CredentialProfileRecord>();
	locked = false;

	async connect(sessionKey: string): Promise<void> {
		this.connectCalls.push(sessionKey);
		this.locked = false;
	}

	async listProfiles() {
		return [...this.records.values()].map((record) => ({
			profile: record.profile,
			...(record.description ? { description: record.description } : {}),
			variableNames: record.variables.map((variable) => variable.name),
			projectKeys: [...record.projectKeys],
		}));
	}

	async readProfile(profile: string): Promise<CredentialProfileRecord> {
		this.readCalls.push(profile);
		const record = this.records.get(profile);
		if (!record) throw new CredentialManagerError("profile_not_found", "Credential profile was not found.");
		return structuredClone(record);
	}

	async writeProfile(record: CredentialProfileRecord): Promise<void> {
		this.records.set(record.profile, structuredClone(record));
	}

	async deleteProfile(profile: string): Promise<void> {
		this.records.delete(profile);
	}

	lock(): void {
		this.locked = true;
	}
}

const alphaProjectKey = `git:${"a".repeat(64)}`;
const betaProjectKey = `git:${"b".repeat(64)}`;
const projects: Record<string, CredentialProjectIdentity> = {
	"/work/alpha": { key: alphaProjectKey, root: "/work/alpha", label: "alpha", portable: true },
	"/work/beta": { key: betaProjectKey, root: "/work/beta", label: "beta", portable: true },
};

function resolveProject(cwd: string): Promise<CredentialProjectIdentity> {
	const identity = projects[cwd];
	if (!identity) throw new Error(`Unexpected test cwd: ${cwd}`);
	return Promise.resolve(identity);
}

describe("CredentialManager", () => {
	it("uses an existing Bitwarden session key to activate the current project without TUI interaction", async () => {
		const sessionKey = "bw-session-key-must-stay-private";
		const secret = "credential-value-must-stay-private";
		const storage = new MemoryCredentialStorage();
		storage.records.set("deploy", {
			profile: "deploy",
			description: "deployment access",
			variables: [{ name: "DEPLOY_TOKEN", value: secret }],
			projectKeys: [alphaProjectKey],
		});
		const manager = new CredentialManager({ storage, resolveProject, initialSessionKey: sessionKey });

		const activated = await manager.activateForProject("/work/alpha");

		expect(activated).toEqual({
			status: "activated",
			profile: "deploy",
			variableNames: ["DEPLOY_TOKEN"],
			project: "alpha",
		});
		expect(manager.getEnvironmentForCwd("/work/alpha/packages/app")).toEqual({ DEPLOY_TOKEN: secret });
		expect(storage.connectCalls).toEqual([sessionKey]);
		expect(JSON.stringify(activated)).not.toContain(secret);
		expect(JSON.stringify(activated)).not.toContain(sessionKey);
	});

	it("rejects an unbound profile before decrypting its values", async () => {
		const storage = new MemoryCredentialStorage();
		storage.records.set("deploy", {
			profile: "deploy",
			variables: [{ name: "DEPLOY_TOKEN", value: "unreachable-secret" }],
			projectKeys: [betaProjectKey],
		});
		const manager = new CredentialManager({ storage, resolveProject, initialSessionKey: "valid-session" });

		await expect(manager.activateForProject("/work/alpha", "deploy")).rejects.toMatchObject({
			code: "project_not_bound",
		});
		expect(storage.readCalls).toEqual([]);
		expect(manager.getEnvironmentForCwd("/work/alpha")).toBeUndefined();
	});

	it("reuses one profile across explicitly bound projects without writing a dotenv file", async () => {
		const storage = new MemoryCredentialStorage();
		const manager = new CredentialManager({ storage, resolveProject, initialSessionKey: "valid-session" });

		const stored = await manager.storeForProject("/work/alpha", {
			profile: "shared-api",
			description: "shared API account",
			dotenv: "API_USER=owner@example.com\nAPI_PASSWORD=correct horse battery staple\n",
		});
		await manager.bindProfileToProject("/work/beta", "shared-api");
		const activated = await manager.activateForProject("/work/beta", "shared-api");

		expect(stored.variableNames).toEqual(["API_USER", "API_PASSWORD"]);
		expect(activated.project).toBe("beta");
		expect(storage.records.get("shared-api")?.projectKeys).toEqual([alphaProjectKey, betaProjectKey]);
		expect(manager.getEnvironmentForCwd("/work/beta")).toEqual({
			API_USER: "owner@example.com",
			API_PASSWORD: "correct horse battery staple",
		});
	});

	it("clears activated values and invalidates the provider session when locked", async () => {
		const storage = new MemoryCredentialStorage();
		const onEnvironmentChanged = vi.fn();
		storage.records.set("deploy", {
			profile: "deploy",
			variables: [{ name: "DEPLOY_TOKEN", value: "hidden" }],
			projectKeys: [alphaProjectKey],
		});
		const manager = new CredentialManager({
			storage,
			resolveProject,
			initialSessionKey: "valid-session",
			onEnvironmentChanged,
		});
		await manager.activateForProject("/work/alpha");
		expect(onEnvironmentChanged).toHaveBeenCalledTimes(1);

		manager.lock();

		expect(storage.locked).toBe(true);
		expect(manager.getEnvironmentForCwd("/work/alpha")).toBeUndefined();
		expect(onEnvironmentChanged).toHaveBeenCalledTimes(2);
	});

	it("does not resurrect a provider connection that completes after the owner locks it", async () => {
		const storage = new MemoryCredentialStorage();
		let finishConnect: (() => void) | undefined;
		storage.connect = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishConnect = resolve;
				}),
		);
		const manager = new CredentialManager({ storage, resolveProject, initialSessionKey: "valid-session" });

		const listing = manager.listForProject("/work/alpha");
		await vi.waitFor(() => expect(storage.connect).toHaveBeenCalledTimes(1));
		manager.lock();
		finishConnect?.();

		await expect(listing).rejects.toMatchObject({ code: "owner_setup_required" });
		expect(manager.status).toEqual({ connected: false, sessionAvailable: false });
		expect(manager.getEnvironmentForCwd("/work/alpha")).toBeUndefined();
	});

	it("does not activate values when the owner locks during a provider read", async () => {
		const storage = new MemoryCredentialStorage();
		storage.records.set("deploy", {
			profile: "deploy",
			variables: [{ name: "DEPLOY_TOKEN", value: "must-stay-inactive" }],
			projectKeys: [alphaProjectKey],
		});
		const originalRead = storage.readProfile.bind(storage);
		let finishRead: (() => void) | undefined;
		storage.readProfile = vi.fn(async (profile) => {
			await new Promise<void>((resolve) => {
				finishRead = resolve;
			});
			return originalRead(profile);
		});
		const manager = new CredentialManager({ storage, resolveProject, initialSessionKey: "valid-session" });

		const activation = manager.activateForProject("/work/alpha", "deploy");
		await vi.waitFor(() => expect(storage.readProfile).toHaveBeenCalledTimes(1));
		manager.lock();
		finishRead?.();

		await expect(activation).rejects.toMatchObject({ code: "owner_setup_required" });
		expect(manager.getEnvironmentForCwd("/work/alpha")).toBeUndefined();
	});
});

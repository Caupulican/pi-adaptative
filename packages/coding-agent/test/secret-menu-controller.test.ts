import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "../src/core/extensions/types.ts";
import {
	CredentialManager,
	CredentialManagerError,
	type CredentialProfileRecord,
	type CredentialProfileStorage,
	type MachineCredentialSession,
} from "../src/core/secrets/credential-manager.ts";
import { SecretMenuController } from "../src/modes/interactive/secret-menu-controller.ts";

const projectKey = `git:${"a".repeat(64)}`;
const tempDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class MemoryStorage implements CredentialProfileStorage {
	readonly connectedWith: string[] = [];
	readonly records = new Map<string, CredentialProfileRecord>();

	async connect(sessionKey: string): Promise<void> {
		this.connectedWith.push(sessionKey);
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

	lock(): void {}
}

function createUi(options: {
	inputs?: string[];
	selections?: string[];
	editors?: string[];
	confirmations?: boolean[];
}) {
	const inputs = [...(options.inputs ?? [])];
	const selections = [...(options.selections ?? [])];
	const editors = [...(options.editors ?? [])];
	const confirmations = [...(options.confirmations ?? [])];
	const inputOptions: Array<ExtensionUIDialogOptions | undefined> = [];
	const notify = vi.fn();
	const input = vi.fn(async (_title: string, _placeholder?: string, dialogOptions?: ExtensionUIDialogOptions) => {
		inputOptions.push(dialogOptions);
		return inputs.shift();
	});
	const custom = vi.fn(async () => editors.shift());
	const select = vi.fn(async () => selections.shift());
	const confirm = vi.fn(async () => confirmations.shift() ?? false);
	const ui = {
		input,
		select,
		confirm,
		notify,
		custom,
	} as unknown as ExtensionUIContext;
	return { ui, input, inputOptions, notify, custom, select, confirm };
}

function createController(
	storage: MemoryStorage,
	options: {
		initialSessionKey?: string;
		resolveMachineSession?: () => Promise<MachineCredentialSession | undefined>;
	} = {},
) {
	const manager = new CredentialManager({
		storage,
		resolveProject: async () => ({ key: projectKey, root: "/work/project", label: "project", portable: true }),
		initialSessionKey: options.initialSessionKey,
		resolveMachineSession: options.resolveMachineSession,
	});
	return { manager, controller: new SecretMenuController({ manager, cwd: "/work/project" }) };
}

describe("SecretMenuController", () => {
	it("does not prompt for Bitwarden credentials on first use", async () => {
		const storage = new MemoryStorage();
		const { controller } = createController(storage);
		const testUi = createUi({ inputs: ["must-not-be-read"], selections: ["Close"] });

		await controller.open(testUi.ui);

		expect(storage.connectedWith).toEqual([]);
		expect(testUi.input).not.toHaveBeenCalled();
		expect(testUi.select).not.toHaveBeenCalled();
		expect(testUi.inputOptions).toEqual([]);
		expect(testUi.notify).toHaveBeenCalledWith(
			"Bitwarden is not connected. Set BWS_ACCESS_TOKEN or BW_SESSION in your environment yourself; Pi never asks for it.",
			"error",
		);
		expect(JSON.stringify(testUi.notify.mock.calls)).not.toContain("must-not-be-read");
	});

	it("does not prompt when a machine-owned session is stale", async () => {
		const storage = new MemoryStorage();
		storage.connect = vi.fn(async () => {
			throw new Error("stale machine session");
		});
		const { controller } = createController(storage, {
			resolveMachineSession: async () => ({
				provider: "bitwarden_password_manager",
				sessionKey: "stale-machine-session",
			}),
		});
		const testUi = createUi({ inputs: ["must-not-be-read"] });

		await controller.open(testUi.ui);

		expect(storage.connectedWith).toEqual([]);
		expect(storage.connect).toHaveBeenCalledWith("stale-machine-session", undefined, "bitwarden_password_manager");
		expect(testUi.input).not.toHaveBeenCalled();
		expect(testUi.select).not.toHaveBeenCalled();
		expect(testUi.notify).toHaveBeenCalledWith(
			"Bitwarden is not connected. Set BWS_ACCESS_TOKEN or BW_SESSION in your environment yourself; Pi never asks for it.",
			"error",
		);
	});

	it("reconnects from machine-owned credentials without prompting", async () => {
		const storage = new MemoryStorage();
		const resolveMachineSession = vi.fn(async () => ({
			provider: "bitwarden_password_manager" as const,
			sessionKey: "machine-session",
		}));
		const { controller } = createController(storage, { resolveMachineSession });
		const testUi = createUi({ inputs: ["must-not-be-read"], selections: ["Reconnect Bitwarden", "Close"] });

		await controller.open(testUi.ui);

		expect(storage.connectedWith).toEqual(["machine-session", "machine-session"]);
		expect(testUi.input).not.toHaveBeenCalled();
		expect(testUi.confirm).not.toHaveBeenCalled();
		expect(testUi.select).toHaveBeenCalledTimes(2);
		expect(resolveMachineSession).toHaveBeenCalledTimes(2);
		expect(testUi.notify).toHaveBeenCalledWith("Bitwarden reconnected from machine-owned credentials.", "info");
	});

	it("reports setup-required when reconnect cannot reread machine credentials", async () => {
		const storage = new MemoryStorage();
		const resolveMachineSession = vi
			.fn()
			.mockResolvedValueOnce({ provider: "bitwarden_password_manager" as const, sessionKey: "machine-session" })
			.mockResolvedValueOnce({ provider: "bitwarden_password_manager" as const, sessionKey: "\ninvalid-session" });
		const { controller, manager } = createController(storage, { resolveMachineSession });
		const testUi = createUi({ inputs: ["must-not-be-read"], selections: ["Reconnect Bitwarden"] });

		await controller.open(testUi.ui);

		expect(storage.connectedWith).toEqual(["machine-session"]);
		expect(testUi.input).not.toHaveBeenCalled();
		expect(testUi.confirm).not.toHaveBeenCalled();
		expect(manager.status.connected).toBe(false);
		expect(testUi.notify).toHaveBeenCalledWith(
			"Bitwarden is not connected. Set BWS_ACCESS_TOKEN or BW_SESSION in your environment yourself; Pi never asks for it.",
			"error",
		);
	});

	it("captures username and password privately and stores only through the manager", async () => {
		const secret = "owner-password-marker";
		const storage = new MemoryStorage();
		const { controller } = createController(storage, { initialSessionKey: "valid-session" });
		const testUi = createUi({
			selections: ["Add or update credentials", "Username and password"],
			inputs: [
				"service-login",
				"shared service account",
				"SERVICE_USER",
				"owner@example.com",
				"SERVICE_PASSWORD",
				secret,
			],
		});

		await controller.open(testUi.ui);

		expect(storage.records.get("service-login")?.variables).toEqual(
			expect.arrayContaining([
				{ name: "SERVICE_USER", value: "owner@example.com" },
				{ name: "SERVICE_PASSWORD", value: secret },
			]),
		);
		expect(testUi.inputOptions).toEqual([
			undefined,
			undefined,
			undefined,
			expect.objectContaining({ sensitive: true }),
			undefined,
			expect.objectContaining({ sensitive: true }),
		]);
		expect(JSON.stringify(testUi.notify.mock.calls)).not.toContain(secret);
	});

	it("keeps the credential hub open for consecutive owner actions", async () => {
		const storage = new MemoryStorage();
		const { controller, manager } = createController(storage, { initialSessionKey: "valid-session" });
		const testUi = createUi({
			selections: ["Add or update credentials", "Username and password", "Lock Pi credentials"],
			inputs: ["service-login", "", "SERVICE_USER", "owner@example.com", "SERVICE_PASSWORD", "secret"],
		});

		await controller.open(testUi.ui);

		expect(testUi.select).toHaveBeenCalledTimes(3);
		expect(manager.status.connected).toBe(false);
		expect(testUi.notify).toHaveBeenCalledWith("Pi credential access is locked for this session.", "info");
	});

	it("imports a dropped private-key file through the private editor without creating a project dotenv", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-secret-menu-"));
		tempDirectories.push(directory);
		const keyPath = join(directory, "deploy.pem");
		const secret = "-----BEGIN PRIVATE KEY-----\nprivate-key-marker\n-----END PRIVATE KEY-----\n";
		await writeFile(keyPath, secret, { mode: 0o600 });
		const storage = new MemoryStorage();
		const { controller } = createController(storage, { initialSessionKey: "valid-session" });
		const testUi = createUi({
			selections: ["Add or update credentials", "API token or private key"],
			inputs: ["deploy-key", "deployment key", "DEPLOY_PRIVATE_KEY"],
			editors: [keyPath],
		});

		await controller.open(testUi.ui);

		expect(storage.records.get("deploy-key")?.variables).toEqual([{ name: "DEPLOY_PRIVATE_KEY", value: secret }]);
		expect(testUi.custom).toHaveBeenCalledOnce();
		expect(JSON.stringify(testUi.notify.mock.calls)).not.toContain(secret);
	});
});

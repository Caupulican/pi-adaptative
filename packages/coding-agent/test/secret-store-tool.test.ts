import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	CredentialManager,
	CredentialManagerError,
	type CredentialProfileRecord,
	type CredentialProfileStorage,
} from "../src/core/secrets/credential-manager.ts";
import { createSecretStoreToolDefinition } from "../src/core/tools/secret-store.ts";

const projectKey = `git:${"a".repeat(64)}`;

class MemoryStorage implements CredentialProfileStorage {
	readonly records = new Map<string, CredentialProfileRecord>();

	async connect(): Promise<void> {}

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

function createContext(mode: "tui" | "print" | "rpc", cwd: string) {
	const input = vi.fn();
	const custom = vi.fn();
	const context = {
		cwd,
		hasUI: mode === "tui",
		mode,
		ui: { input, custom, notify: vi.fn(), confirm: vi.fn() },
	} as unknown as ExtensionContext;
	return { context, input, custom };
}

function createHarness(options: { initialSessionKey?: string } = { initialSessionKey: "valid-session" }) {
	const storage = new MemoryStorage();
	const manager = new CredentialManager({
		storage,
		resolveProject: async () => ({ key: projectKey, root: "/work/project", label: "project", portable: true }),
		initialSessionKey: options.initialSessionKey,
	});
	return { storage, manager, tool: createSecretStoreToolDefinition({ manager }) };
}

describe("secret_store tool", () => {
	it.each(["print", "rpc"] as const)("activates a bound profile autonomously in %s mode", async (mode) => {
		const secret = "model-hidden-secret-value";
		const { storage, manager, tool } = createHarness();
		storage.records.set("deploy", {
			profile: "deploy",
			variables: [{ name: "DEPLOY_TOKEN", value: secret }],
			projectKeys: [projectKey],
		});
		const ui = createContext(mode, "/work/project");

		const activated = await tool.execute("activate", { action: "activate" }, undefined, undefined, ui.context);

		expect(activated.details).toEqual({
			action: "activate",
			status: "activated",
			profile: "deploy",
			variableNames: ["DEPLOY_TOKEN"],
			project: "project",
		});
		expect(manager.getEnvironmentForCwd("/work/project")).toEqual({ DEPLOY_TOKEN: secret });
		expect(JSON.stringify(activated)).not.toContain(secret);
		expect(ui.input).not.toHaveBeenCalled();
		expect(ui.custom).not.toHaveBeenCalled();
	});

	it("lists only metadata and current-project binding state", async () => {
		const secret = "metadata-must-not-contain-this";
		const { storage, tool } = createHarness();
		storage.records.set("deploy", {
			profile: "deploy",
			description: "deployment account",
			variables: [{ name: "DEPLOY_TOKEN", value: secret }],
			projectKeys: [projectKey],
		});
		const ui = createContext("rpc", "/work/project");

		const listed = await tool.execute("list", { action: "list" }, undefined, undefined, ui.context);

		expect(listed.details.profiles).toEqual([
			{
				profile: "deploy",
				description: "deployment account",
				variableNames: ["DEPLOY_TOKEN"],
				boundToCurrentProject: true,
			},
		]);
		expect(JSON.stringify(listed)).not.toContain(secret);
	});

	it("returns an owner setup requirement instead of prompting when no session key is available", async () => {
		const { tool } = createHarness({});
		const ui = createContext("tui", "/work/project");

		const result = await tool.execute("activate", { action: "activate" }, undefined, undefined, ui.context);

		expect(result.details).toMatchObject({
			action: "activate",
			status: "unavailable",
			code: "owner_setup_required",
		});
		expect(ui.input).not.toHaveBeenCalled();
		expect(ui.custom).not.toHaveBeenCalled();
	});

	it("exposes no model-facing credential mutation actions", () => {
		const { tool } = createHarness();
		const schema = JSON.stringify(tool.parameters);

		expect(schema).toContain("activate");
		expect(schema).toContain("list");
		expect(schema).toContain("status");
		for (const forbidden of ["set", "remove", "lock", "materialize", "envFile", "variableNames"]) {
			expect(schema).not.toContain(forbidden);
		}
	});
});

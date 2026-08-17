import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	CredentialManager,
	CredentialManagerError,
	type CredentialProfileRecord,
	type CredentialProfileStorage,
	CredentialStorageError,
} from "../src/core/secrets/credential-manager.ts";
import { createSecretStoreToolDefinition } from "../src/core/tools/secret-store.ts";

const projectKey = `git:${"a".repeat(64)}`;

class MemoryStorage implements CredentialProfileStorage {
	readonly records = new Map<string, CredentialProfileRecord>();
	readonly rejectedSessionKeys = new Set<string>();

	async connect(sessionKey: string): Promise<void> {
		if (this.rejectedSessionKeys.has(sessionKey)) {
			throw new CredentialStorageError(
				"provider_command_failed",
				"Bitwarden command failed safely without exposing provider output.",
			);
		}
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

function createContext(mode: "tui" | "print" | "rpc", cwd: string) {
	const input = vi.fn();
	const custom = vi.fn();
	const confirm = vi.fn();
	const context = {
		cwd,
		hasUI: mode === "tui",
		mode,
		ui: { input, custom, notify: vi.fn(), confirm },
	} as unknown as ExtensionContext;
	return { context, input, custom, confirm };
}

function createHarness(
	options: {
		initialSessionKey?: string;
		resolveMigrationSources?: () => Promise<Array<{ name: string; value: string }>>;
	} = { initialSessionKey: "valid-session" },
) {
	const storage = new MemoryStorage();
	const manager = new CredentialManager({
		storage,
		resolveProject: async () => ({ key: projectKey, root: "/work/project", label: "project", portable: true }),
		initialSessionKey: options.initialSessionKey,
	});
	return {
		storage,
		manager,
		tool: createSecretStoreToolDefinition({
			manager,
			...(options.resolveMigrationSources ? { resolveMigrationSources: options.resolveMigrationSources } : {}),
		}),
	};
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

	it("requests only one masked BW_SESSION key and then completes the credential action", async () => {
		const secret = "connected-after-owner-key";
		const { storage, manager, tool } = createHarness({});
		storage.records.set("deploy", {
			profile: "deploy",
			variables: [{ name: "DEPLOY_TOKEN", value: secret }],
			projectKeys: [projectKey],
		});
		const ui = createContext("tui", "/work/project");
		ui.input.mockResolvedValue("valid-session");

		const result = await tool.execute("activate", { action: "activate" }, undefined, undefined, ui.context);

		expect(result.details).toEqual({
			action: "activate",
			status: "activated",
			profile: "deploy",
			variableNames: ["DEPLOY_TOKEN"],
			project: "project",
		});
		expect(ui.input).toHaveBeenCalledOnce();
		expect(ui.input).toHaveBeenCalledWith("Connect Bitwarden", "Paste BW_SESSION session key", {
			sensitive: true,
		});
		expect(manager.getEnvironmentForCwd("/work/project")).toEqual({ DEPLOY_TOKEN: secret });
		expect(JSON.stringify(result)).not.toContain("valid-session");
		expect(ui.custom).not.toHaveBeenCalled();
		expect(ui.confirm).not.toHaveBeenCalled();
	});

	it("cancels without reading migration sources when the masked key prompt is dismissed", async () => {
		const resolveMigrationSources = vi.fn(async () => [{ name: "DEPLOY_TOKEN", value: "must-not-be-loaded" }]);
		const { tool } = createHarness({ resolveMigrationSources });
		const ui = createContext("tui", "/work/project");
		ui.input.mockResolvedValue(undefined);

		const result = await tool.execute(
			"migrate",
			{
				action: "migrate",
				profile: "deploy",
				sources: [{ kind: "environment", name: "DEPLOY_TOKEN" }],
			},
			undefined,
			undefined,
			ui.context,
		);

		expect(result.details).toEqual({ action: "migrate", status: "cancelled", code: "cancelled" });
		expect(ui.input).toHaveBeenCalledOnce();
		expect(resolveMigrationSources).not.toHaveBeenCalled();
		expect(ui.custom).not.toHaveBeenCalled();
		expect(ui.confirm).not.toHaveBeenCalled();
	});

	it("replaces a stale process session by requesting only a fresh masked key", async () => {
		const secret = "stale-session-recovery-secret";
		const { storage, manager, tool } = createHarness({ initialSessionKey: "stale-session" });
		storage.rejectedSessionKeys.add("stale-session");
		storage.records.set("deploy", {
			profile: "deploy",
			variables: [{ name: "DEPLOY_TOKEN", value: secret }],
			projectKeys: [projectKey],
		});
		const ui = createContext("tui", "/work/project");
		ui.input.mockResolvedValue("fresh-session");

		const result = await tool.execute("activate", { action: "activate" }, undefined, undefined, ui.context);

		expect(result.details).toMatchObject({ status: "activated", profile: "deploy" });
		expect(ui.input).toHaveBeenCalledOnce();
		expect(ui.input).toHaveBeenCalledWith("Connect Bitwarden", "Paste BW_SESSION session key", {
			sensitive: true,
		});
		expect(manager.getEnvironmentForCwd("/work/project")).toEqual({ DEPLOY_TOKEN: secret });
		expect(JSON.stringify(result)).not.toContain("fresh-session");
		expect(ui.custom).not.toHaveBeenCalled();
		expect(ui.confirm).not.toHaveBeenCalled();
	});

	it("does not load migration sources before the external vault is available", async () => {
		const resolveMigrationSources = vi.fn(async () => [{ name: "DEPLOY_TOKEN", value: "must-not-be-loaded" }]);
		const { tool } = createHarness({ resolveMigrationSources });
		const ui = createContext("print", "/work/project");

		const result = await tool.execute(
			"migrate",
			{
				action: "migrate",
				profile: "deploy",
				sources: [{ kind: "environment", name: "DEPLOY_TOKEN" }],
			},
			undefined,
			undefined,
			ui.context,
		);

		expect(result.details).toMatchObject({
			action: "migrate",
			status: "unavailable",
			code: "owner_setup_required",
		});
		const [message] = result.content;
		expect(message?.type).toBe("text");
		if (message?.type !== "text") throw new Error("Expected a text-only owner setup result.");
		expect(message.text).toContain("one owner input: a BW_SESSION key");
		expect(message.text).not.toContain("/secrets");
		expect(resolveMigrationSources).not.toHaveBeenCalled();
		expect(ui.input).not.toHaveBeenCalled();
	});

	it.each(["print", "rpc"] as const)(
		"migrates accessible credentials without owner interaction in %s mode",
		async (mode) => {
			const secret = "migration-value-must-never-reach-the-model";
			const resolveMigrationSources = vi.fn(async () => [{ name: "DEPLOY_TOKEN", value: secret }]);
			const { storage, manager, tool } = createHarness({
				initialSessionKey: "valid-session",
				resolveMigrationSources,
			});
			const ui = createContext(mode, "/work/project");

			const migrated = await tool.execute(
				"migrate",
				{
					action: "migrate",
					profile: "deploy",
					sources: [{ kind: "environment", name: "DEPLOY_TOKEN" }],
				},
				undefined,
				undefined,
				ui.context,
			);

			expect(resolveMigrationSources).toHaveBeenCalledWith(
				[{ kind: "environment", name: "DEPLOY_TOKEN" }],
				"/work/project",
				undefined,
			);
			expect(migrated.details).toEqual({
				action: "migrate",
				status: "migrated",
				profile: "deploy",
				variableNames: ["DEPLOY_TOKEN"],
				project: "project",
				sourceRetained: true,
			});
			expect(storage.records.get("deploy")?.variables).toEqual([{ name: "DEPLOY_TOKEN", value: secret }]);
			expect(manager.getEnvironmentForCwd("/work/project")).toEqual({ DEPLOY_TOKEN: secret });
			expect(JSON.stringify(migrated)).not.toContain(secret);
			expect(ui.input).not.toHaveBeenCalled();
			expect(ui.custom).not.toHaveBeenCalled();
		},
	);

	it("rejects an existing profile before loading sources unless overwrite is explicit", async () => {
		const candidate = { name: "DEPLOY_TOKEN", value: "replacement-must-stay-hidden" };
		const resolveMigrationSources = vi.fn(async () => [candidate]);
		const { storage, tool } = createHarness({
			initialSessionKey: "valid-session",
			resolveMigrationSources,
		});
		storage.records.set("deploy", {
			profile: "deploy",
			variables: [{ name: "DEPLOY_TOKEN", value: "existing-value" }],
			projectKeys: [projectKey],
		});
		const ui = createContext("rpc", "/work/project");

		const migrated = await tool.execute(
			"migrate",
			{
				action: "migrate",
				profile: "deploy",
				sources: [{ kind: "environment", name: "DEPLOY_TOKEN" }],
			},
			undefined,
			undefined,
			ui.context,
		);

		expect(migrated.details).toMatchObject({ status: "error", code: "profile_exists" });
		expect(JSON.stringify(migrated)).not.toContain("replacement-must-stay-hidden");
		expect(storage.records.get("deploy")?.variables).toEqual([{ name: "DEPLOY_TOKEN", value: "existing-value" }]);
		expect(resolveMigrationSources).not.toHaveBeenCalled();
		expect(candidate.value).toBe("replacement-must-stay-hidden");
	});

	it("replaces an existing profile only with explicit overwrite and preserves its bindings", async () => {
		const replacement = { name: "DEPLOY_TOKEN", value: "replacement-must-stay-hidden" };
		const { storage, manager, tool } = createHarness({
			initialSessionKey: "valid-session",
			resolveMigrationSources: async () => [replacement],
		});
		const secondProjectKey = `git:${"b".repeat(64)}`;
		storage.records.set("deploy", {
			profile: "deploy",
			description: "existing description",
			variables: [{ name: "DEPLOY_TOKEN", value: "existing-value" }],
			projectKeys: [secondProjectKey],
		});
		const ui = createContext("rpc", "/work/project");

		const migrated = await tool.execute(
			"migrate",
			{
				action: "migrate",
				profile: "deploy",
				overwrite: true,
				sources: [{ kind: "environment", name: "DEPLOY_TOKEN" }],
			},
			undefined,
			undefined,
			ui.context,
		);

		expect(migrated.details).toMatchObject({ status: "migrated", profile: "deploy" });
		expect(JSON.stringify(migrated)).not.toContain("replacement-must-stay-hidden");
		expect(storage.records.get("deploy")).toEqual({
			profile: "deploy",
			description: "existing description",
			variables: [{ name: "DEPLOY_TOKEN", value: "replacement-must-stay-hidden" }],
			projectKeys: [secondProjectKey, projectKey],
		});
		expect(manager.getEnvironmentForCwd("/work/project")).toEqual({
			DEPLOY_TOKEN: "replacement-must-stay-hidden",
		});
		expect(replacement.value).toBe("");
	});

	it("clears resolved candidate values after a downstream validation failure", async () => {
		const candidate = { name: "INVALID-NAME", value: "invalid-candidate-must-stay-hidden" };
		const { storage, tool } = createHarness({
			initialSessionKey: "valid-session",
			resolveMigrationSources: async () => [candidate],
		});
		const ui = createContext("rpc", "/work/project");

		const migrated = await tool.execute(
			"migrate",
			{
				action: "migrate",
				profile: "deploy",
				sources: [{ kind: "environment", name: "DEPLOY_TOKEN" }],
			},
			undefined,
			undefined,
			ui.context,
		);

		expect(migrated.details).toMatchObject({ status: "error", code: "invalid_provider_record" });
		expect(JSON.stringify(migrated)).not.toContain("invalid-candidate-must-stay-hidden");
		expect(storage.records.has("deploy")).toBe(false);
		expect(candidate.value).toBe("");
	});

	it("exposes model-blind migration descriptors without accepting credential values", () => {
		const { tool } = createHarness();
		const schema = JSON.stringify(tool.parameters);
		const teachings = tool.promptGuidelines?.join("\n") ?? "";

		expect(schema).toContain("activate");
		expect(schema).toContain("list");
		expect(schema).toContain("status");
		expect(schema).toContain("migrate");
		expect(schema).toContain("dotenv_file");
		expect(schema).toContain("environment");
		expect(schema).toContain("file");
		for (const forbidden of ['"set"', '"remove"', '"lock"', '"materialize"', '"dotenv"', '"value"', '"secret"']) {
			expect(schema).not.toContain(forbidden);
		}
		expect(teachings).toContain("one masked BW_SESSION only");
		expect(teachings).toContain("current task genuinely requires credentials");
		expect(teachings).toContain("Never probe or activate for an optional integration");
		expect(teachings).not.toContain("run /secrets");
	});
});

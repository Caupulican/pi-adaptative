import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, ExtensionUIDialogOptions } from "../src/core/extensions/types.ts";
import { SecretVault } from "../src/core/secrets/secret-vault.ts";
import { createSecretStoreToolDefinition } from "../src/core/tools/secret-store.ts";

interface TestUI {
	context: ExtensionContext;
	inputOptions: Array<ExtensionUIDialogOptions | undefined>;
	editorCalls: ReturnType<typeof vi.fn>;
	notify: ReturnType<typeof vi.fn>;
}

function createContext(options: {
	mode?: "tui" | "print" | "rpc";
	hasUI?: boolean;
	inputs?: string[];
	editors?: string[];
	confirms?: boolean[];
	cwd: string;
}): TestUI {
	const inputs = [...(options.inputs ?? [])];
	const confirms = [...(options.confirms ?? [])];
	const editors = [...(options.editors ?? [])];
	const inputOptions: Array<ExtensionUIDialogOptions | undefined> = [];
	const notify = vi.fn();
	const editorCalls = vi.fn();
	const context = {
		cwd: options.cwd,
		hasUI: options.hasUI ?? true,
		mode: options.mode ?? "tui",
		ui: {
			input: async (_title: string, _placeholder?: string, dialogOptions?: ExtensionUIDialogOptions) => {
				inputOptions.push(dialogOptions);
				return inputs.shift();
			},
			confirm: async () => confirms.shift() ?? false,
			custom: async () => {
				editorCalls();
				return editors.shift();
			},
			notify,
		},
	} as unknown as ExtensionContext;
	return { context, inputOptions, editorCalls, notify };
}

describe("secret_store tool", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function createHarness() {
		const root = mkdtempSync(join(tmpdir(), "pi-secret-tool-"));
		tempDirs.push(root);
		const vault = new SecretVault({ agentDir: join(root, "agent"), scryptN: 1_024 });
		return { root, vault, tool: createSecretStoreToolDefinition({ vault }) };
	}

	it("captures a plaintext dotenv through the private editor while returning metadata only", async () => {
		const { root, vault, tool } = createHarness();
		const passphrase = "model-blind-passphrase";
		const secret = "credential-value-marker";
		const ui = createContext({ cwd: root, inputs: [passphrase, passphrase], editors: [`API_TOKEN=${secret}\n`] });

		const stored = await tool.execute(
			"call-set",
			{ action: "set", profile: "project", envFile: ".env" },
			undefined,
			undefined,
			ui.context,
		);
		const serializedResult = JSON.stringify(stored);
		expect(serializedResult).not.toContain(passphrase);
		expect(serializedResult).not.toContain(secret);
		expect(stored.details).toMatchObject({
			status: "stored",
			profile: "project",
			variableNames: ["API_TOKEN"],
		});
		expect(ui.inputOptions).toHaveLength(2);
		expect(ui.inputOptions.every((options) => options?.sensitive === true)).toBe(true);
		expect(ui.editorCalls).toHaveBeenCalledOnce();
		expect(readFileSync(vault.vaultPath, "utf8")).not.toContain(secret);
		expect(readFileSync(join(root, ".env"), "utf8")).toContain(`API_TOKEN=${secret}`);

		const listed = await tool.execute("call-list", { action: "list" }, undefined, undefined, ui.context);
		expect(listed.details.profiles?.[0]).toMatchObject({ profile: "project", variableNames: ["API_TOKEN"] });
		expect(JSON.stringify(listed)).not.toContain(secret);
	});

	it("materializes a remembered binding and withholds path and value from the result", async () => {
		const { root, vault, tool } = createHarness();
		await vault.initialize("model-blind-passphrase");
		await vault.replaceProfileDocument("project", undefined, "API_TOKEN=hidden-value\n", {
			workspace: root,
			envFile: ".env",
		});
		const ui = createContext({ cwd: root });

		const materialized = await tool.execute(
			"call-materialize",
			{ action: "materialize", profile: "project", scope: "managed" },
			undefined,
			undefined,
			ui.context,
		);
		const serialized = JSON.stringify(materialized);
		expect(materialized.details.status).toBe("materialized");
		expect(serialized).not.toContain("hidden-value");
		expect(serialized).not.toContain(root);
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining(vault.getManagedEnvPath("project")), "info");
		expect(vault.getEnvironmentForCwd(root)).toMatchObject({ API_TOKEN: "hidden-value" });
	});

	it("persists the model-selected relative dotenv location without asking the owner for a path", async () => {
		const { root, vault, tool } = createHarness();
		const passphrase = "model-blind-passphrase";
		const ui = createContext({
			cwd: root,
			inputs: [passphrase, passphrase],
			editors: ["API_TOKEN=workspace-secret\n"],
		});

		const stored = await tool.execute(
			"call-set-location",
			{ action: "set", profile: "project", envFile: ".env.local" },
			undefined,
			undefined,
			ui.context,
		);
		expect(stored.details).toMatchObject({ status: "stored", envFile: ".env.local", materialized: true });
		expect(JSON.stringify(stored)).not.toContain(root);
		expect(JSON.stringify(stored)).not.toContain("workspace-secret");
		expect(readFileSync(join(root, ".env.local"), "utf8")).toContain("API_TOKEN=workspace-secret");
		expect((await vault.listProfiles())[0]?.bindings).toEqual([
			expect.objectContaining({ workspace: root, envFile: ".env.local" }),
		]);
		expect(ui.inputOptions).toHaveLength(2);
	});

	it("keeps passphrase and dotenv corrections inside the owner UI", async () => {
		const { root, tool } = createHarness();
		const passphrase = "corrected-model-blind-passphrase";
		const secret = "corrected-private-value";
		const ui = createContext({
			cwd: root,
			inputs: ["first-mismatched-passphrase", "second-mismatched-passphrase", passphrase, passphrase],
			editors: ["not an assignment\n", `TOKEN=${secret}\n`],
		});

		const stored = await tool.execute(
			"call-corrected-set",
			{ action: "set", profile: "corrected" },
			undefined,
			undefined,
			ui.context,
		);
		expect(stored.details).toMatchObject({ status: "stored", variableNames: ["TOKEN"] });
		expect(JSON.stringify(stored)).not.toContain(secret);
		expect(ui.inputOptions).toHaveLength(4);
		expect(ui.editorCalls).toHaveBeenCalledTimes(2);
		expect(ui.notify).toHaveBeenCalledWith("The two master passphrases do not match.", "error");
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("expected NAME=value"), "error");
	});

	it("refuses non-TUI and unattended invocations before requesting input", async () => {
		const { root, tool } = createHarness();
		const rpc = createContext({ cwd: root, mode: "rpc", inputs: ["must-not-be-read"] });

		const refused = await tool.execute(
			"call-rpc",
			{ action: "set", profile: "project" },
			undefined,
			undefined,
			rpc.context,
		);
		expect(refused.details).toMatchObject({ status: "unavailable", code: "user_tui_required" });
		expect(rpc.inputOptions).toEqual([]);
	});
});

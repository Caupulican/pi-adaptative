import { describe, expect, it } from "vitest";
import {
	type BitwardenCommandRequest,
	type BitwardenCommandResult,
	BitwardenCredentialStorage,
	BitwardenCredentialStorageError,
} from "../src/core/secrets/bitwarden-credential-storage.ts";
import type { CredentialProfileRecord } from "../src/core/secrets/credential-manager.ts";

function createFakeBitwarden() {
	const calls: BitwardenCommandRequest[] = [];
	const items: Array<Record<string, unknown>> = [];
	const run = async (request: BitwardenCommandRequest): Promise<BitwardenCommandResult> => {
		calls.push(structuredClone(request));
		const [command, object, id] = request.args;
		if (command === "sync") return { exitCode: 0, stdout: "Syncing complete.", stderr: "" };
		if (command === "list" && object === "items") {
			return { exitCode: 0, stdout: JSON.stringify(items), stderr: "" };
		}
		if (command === "get" && object === "template") {
			return {
				exitCode: 0,
				stdout: JSON.stringify({ type: 1, name: "", notes: null, secureNote: { type: 0 } }),
				stderr: "",
			};
		}
		if (command === "create" && object === "item") {
			const item = JSON.parse(Buffer.from(request.input ?? "", "base64").toString("utf8")) as Record<
				string,
				unknown
			>;
			item.id = "11111111-1111-4111-8111-111111111111";
			items.push(item);
			return { exitCode: 0, stdout: JSON.stringify(item), stderr: "" };
		}
		if (command === "edit" && object === "item" && id) {
			const index = items.findIndex((item) => item.id === id);
			const item = JSON.parse(Buffer.from(request.input ?? "", "base64").toString("utf8")) as Record<
				string,
				unknown
			>;
			item.id = id;
			items[index] = item;
			return { exitCode: 0, stdout: JSON.stringify(item), stderr: "" };
		}
		if (command === "delete" && object === "item" && id) {
			const index = items.findIndex((item) => item.id === id);
			if (index >= 0) items.splice(index, 1);
			return { exitCode: 0, stdout: "", stderr: "" };
		}
		throw new Error(`Unexpected fake bw invocation: ${request.args.join(" ")}`);
	};
	return { calls, items, run };
}

describe("BitwardenCredentialStorage", () => {
	it("provisions bw, syncs, and sends credential JSON through stdin without secret arguments or results", async () => {
		const sessionKey = "bitwarden-session-key-marker";
		const secret = "bitwarden-secret-value-marker";
		const fake = createFakeBitwarden();
		const resolutions: string[] = [];
		const storage = new BitwardenCredentialStorage({
			resolveTool: async (tool) => {
				resolutions.push(tool);
				return { status: "available", path: "/managed/bin/bw" };
			},
			runCommand: fake.run,
		});
		const record: CredentialProfileRecord = {
			profile: "deploy",
			description: "deployment account",
			variables: [{ name: "DEPLOY_TOKEN", value: secret }],
			projectKeys: [`git:${"a".repeat(64)}`],
		};

		await storage.connect(sessionKey);
		await storage.writeProfile(record);
		const summaries = await storage.listProfiles();
		const restored = await storage.readProfile("deploy");

		expect(resolutions).toEqual(["bw"]);
		expect(summaries).toEqual([
			{
				profile: "deploy",
				description: "deployment account",
				variableNames: ["DEPLOY_TOKEN"],
				projectKeys: [`git:${"a".repeat(64)}`],
			},
		]);
		expect(restored).toEqual(record);
		expect(fake.calls.some((call) => call.args[0] === "sync")).toBe(true);
		expect(fake.calls.some((call) => call.args[0] === "create")).toBe(true);
		for (const call of fake.calls) {
			expect(call.executable).toBe("/managed/bin/bw");
			expect(JSON.stringify(call.args)).not.toContain(sessionKey);
			expect(JSON.stringify(call.args)).not.toContain(secret);
			expect(call.sessionKey).toBe(sessionKey);
		}
		expect(JSON.stringify(summaries)).not.toContain(sessionKey);
		expect(JSON.stringify(summaries)).not.toContain(secret);
	});

	it("rejects malformed Pi-owned items with a bounded error that does not echo their notes", async () => {
		const leaked = "malformed-note-secret-marker";
		const fake = createFakeBitwarden();
		fake.items.push({
			id: "11111111-1111-4111-8111-111111111111",
			type: 2,
			name: "Pi credential profile · malformed",
			notes: leaked,
			secureNote: { type: 0 },
		});
		const storage = new BitwardenCredentialStorage({
			resolveTool: async () => ({ status: "available", path: "/managed/bin/bw" }),
			runCommand: fake.run,
		});

		let caught: unknown;
		try {
			await storage.connect("valid-session");
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(BitwardenCredentialStorageError);
		expect(caught).toMatchObject({ code: "malformed_provider_data" });
		expect(String(caught)).not.toContain(leaked);
	});

	it("maps CLI failures to stable errors without forwarding stdout, stderr, or the session key", async () => {
		const leaked = "provider-error-secret-marker";
		const sessionKey = "invalid-session-key-marker";
		const storage = new BitwardenCredentialStorage({
			resolveTool: async () => ({ status: "available", path: "/managed/bin/bw" }),
			runCommand: async (request) => ({
				exitCode: 1,
				stdout: `${leaked} ${request.sessionKey}`,
				stderr: `${leaked} ${request.sessionKey}`,
			}),
		});

		let caught: unknown;
		try {
			await storage.connect(sessionKey);
		} catch (error) {
			caught = error;
		}

		expect(caught).toMatchObject({ code: "provider_command_failed" });
		expect(String(caught)).not.toContain(leaked);
		expect(String(caught)).not.toContain(sessionKey);
	});

	it("uses Bitwarden's encrypted local cache when network sync fails", async () => {
		const calls: string[][] = [];
		const storage = new BitwardenCredentialStorage({
			resolveTool: async () => ({ status: "available", path: "/managed/bin/bw" }),
			runCommand: async (request) => {
				calls.push(request.args);
				if (request.args[0] === "sync") return { exitCode: 1, stdout: "", stderr: "offline" };
				return { exitCode: 0, stdout: "[]", stderr: "" };
			},
		});

		await storage.connect("valid-session");

		expect(await storage.listProfiles()).toEqual([]);
		expect(calls.map((args) => args[0])).toEqual(["sync", "list"]);
	});

	it("rejects duplicate provider records instead of choosing one nondeterministically", async () => {
		const fake = createFakeBitwarden();
		const item = {
			id: "11111111-1111-4111-8111-111111111111",
			type: 2,
			name: "Pi credential profile · deploy",
			notes: JSON.stringify({
				kind: "pi.credential-profile",
				schema: 1,
				profile: "deploy",
				variables: [{ name: "DEPLOY_TOKEN", value: "hidden" }],
				projectKeys: [`git:${"a".repeat(64)}`],
			}),
			secureNote: { type: 0 },
		};
		fake.items.push(item, { ...item, id: "22222222-2222-4222-8222-222222222222" });
		const storage = new BitwardenCredentialStorage({
			resolveTool: async () => ({ status: "available", path: "/managed/bin/bw" }),
			runCommand: fake.run,
		});

		await expect(storage.connect("valid-session")).rejects.toMatchObject({
			code: "malformed_provider_data",
		});
	});

	it("uses recoverable Bitwarden deletion without the permanent flag", async () => {
		const fake = createFakeBitwarden();
		const storage = new BitwardenCredentialStorage({
			resolveTool: async () => ({ status: "available", path: "/managed/bin/bw" }),
			runCommand: fake.run,
		});
		await storage.connect("valid-session");
		await storage.writeProfile({
			profile: "deploy",
			variables: [{ name: "DEPLOY_TOKEN", value: "hidden" }],
			projectKeys: [`git:${"a".repeat(64)}`],
		});

		await storage.deleteProfile("deploy");

		const deletion = fake.calls.find((call) => call.args[0] === "delete");
		expect(deletion?.args).toEqual(["delete", "item", "11111111-1111-4111-8111-111111111111"]);
	});
});

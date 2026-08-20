import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type BitwardenSecretsManagerCommandRequest,
	type BitwardenSecretsManagerCommandResult,
	BitwardenSecretsManagerCredentialStorage,
} from "../src/core/secrets/bitwarden-secrets-manager-storage.ts";
import type { CredentialProfileRecord } from "../src/core/secrets/credential-manager.ts";
import { CREDENTIAL_PROFILE_KEY_PREFIX } from "../src/core/secrets/credential-profile-envelope.ts";

const projectId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";

let testDir = "";
let coordinationFile = "";

beforeEach(async () => {
	testDir = await mkdtemp(join(tmpdir(), "pi-bws-storage-"));
	coordinationFile = join(testDir, "bootstrap");
});

afterEach(async () => {
	await rm(testDir, { recursive: true, force: true });
});

function createFakeSecretsManager() {
	const calls: BitwardenSecretsManagerCommandRequest[] = [];
	const projects: Array<Record<string, unknown>> = [];
	const secrets: Array<Record<string, unknown>> = [];
	let nextSecret = 0;
	const run = async (
		request: BitwardenSecretsManagerCommandRequest,
	): Promise<BitwardenSecretsManagerCommandResult> => {
		calls.push(structuredClone(request));
		const [subject, action, first] = request.args;
		if (subject === "project" && action === "list") {
			return { exitCode: 0, stdout: JSON.stringify(projects), stderr: "" };
		}
		if (subject === "project" && action === "create") {
			const project = { id: projectId, organizationId, name: first };
			projects.push(project);
			return { exitCode: 0, stdout: JSON.stringify(project), stderr: "" };
		}
		if (subject === "secret" && action === "list") {
			return { exitCode: 0, stdout: JSON.stringify(secrets), stderr: "" };
		}
		if (subject === "secret" && action === "create") {
			const secret = {
				id: `33333333-3333-4333-8333-${(++nextSecret).toString().padStart(12, "0")}`,
				organizationId,
				projectId,
				key: request.args[2],
				value: request.args[3],
				note: "",
			};
			secrets.push(secret);
			return { exitCode: 0, stdout: JSON.stringify(secret), stderr: "" };
		}
		if (subject === "secret" && action === "edit" && first) {
			const secret = secrets.find((candidate) => candidate.id === first);
			if (!secret) return { exitCode: 1, stdout: "", stderr: "missing" };
			const valueIndex = request.args.indexOf("--value");
			if (valueIndex >= 0) secret.value = request.args[valueIndex + 1];
			return { exitCode: 0, stdout: JSON.stringify(secret), stderr: "" };
		}
		if (subject === "secret" && action === "delete" && first) {
			const index = secrets.findIndex((candidate) => candidate.id === first);
			if (index >= 0) secrets.splice(index, 1);
			return { exitCode: 0, stdout: "1 secret deleted successfully.", stderr: "" };
		}
		throw new Error(`Unexpected fake bws invocation: ${request.args.join(" ")}`);
	};
	return { calls, projects, run, secrets };
}

describe("BitwardenSecretsManagerCredentialStorage", () => {
	it("creates one managed project and keeps profile plaintext out of process arguments", async () => {
		const accessToken = "machine-access-token-marker";
		const privateValue = "credential-plaintext-marker";
		const fake = createFakeSecretsManager();
		const resolved: string[] = [];
		const storage = new BitwardenSecretsManagerCredentialStorage({
			coordinationFile,
			resolveTool: async (tool) => {
				resolved.push(tool);
				return { status: "available", path: "/managed/bin/bws" };
			},
			runCommand: fake.run,
		});
		const record: CredentialProfileRecord = {
			profile: "deploy",
			description: "deployment account",
			variables: [{ name: "DEPLOY_TOKEN", value: privateValue }],
			projectKeys: [`git:${"a".repeat(64)}`],
		};

		await storage.connect(accessToken);
		await storage.writeProfile(record);

		expect(resolved).toEqual(["bws"]);
		expect(fake.projects).toEqual([{ id: projectId, organizationId, name: "Pi Credential Profiles" }]);
		expect(await storage.listProfiles()).toEqual([
			{
				profile: "deploy",
				description: "deployment account",
				variableNames: ["DEPLOY_TOKEN"],
				projectKeys: [`git:${"a".repeat(64)}`],
			},
		]);
		expect(await storage.readProfile("deploy")).toEqual(record);
		for (const call of fake.calls) {
			expect(call.executable).toBe("/managed/bin/bws");
			expect(call.accessToken).toBe(accessToken);
			expect(JSON.stringify(call.args)).not.toContain(accessToken);
			expect(JSON.stringify(call.args)).not.toContain(privateValue);
		}
	});

	it("reloads encrypted profiles with a fresh adapter and updates them in place", async () => {
		const fake = createFakeSecretsManager();
		const options = {
			coordinationFile,
			resolveTool: async () => ({ status: "available" as const, path: "/managed/bin/bws" }),
			runCommand: fake.run,
		};
		const first = new BitwardenSecretsManagerCredentialStorage(options);
		await first.connect("machine-token");
		await first.writeProfile({
			profile: "deploy",
			variables: [{ name: "DEPLOY_TOKEN", value: "first-value" }],
			projectKeys: [`git:${"a".repeat(64)}`],
		});

		const second = new BitwardenSecretsManagerCredentialStorage(options);
		await second.connect("machine-token");
		await second.writeProfile({
			profile: "deploy",
			variables: [{ name: "DEPLOY_TOKEN", value: "second-value" }],
			projectKeys: [`git:${"a".repeat(64)}`],
		});

		expect((await second.readProfile("deploy")).variables).toEqual([{ name: "DEPLOY_TOKEN", value: "second-value" }]);
		expect(fake.calls.filter((call) => call.args.slice(0, 2).join(" ") === "project create")).toHaveLength(1);
		expect(fake.calls.filter((call) => call.args.slice(0, 2).join(" ") === "secret edit")).toHaveLength(1);
	});

	it("serializes concurrent project and encryption-key bootstrap across adapters", async () => {
		const fake = createFakeSecretsManager();
		const options = {
			coordinationFile,
			resolveTool: async () => ({ status: "available" as const, path: "/managed/bin/bws" }),
			runCommand: fake.run,
		};
		const first = new BitwardenSecretsManagerCredentialStorage(options);
		const second = new BitwardenSecretsManagerCredentialStorage(options);

		await Promise.all([first.connect("machine-token"), second.connect("machine-token")]);
		await Promise.all([
			first.writeProfile({
				profile: "deploy",
				variables: [{ name: "TOKEN", value: "first-value" }],
				projectKeys: [`git:${"a".repeat(64)}`],
			}),
			second.writeProfile({
				profile: "deploy",
				variables: [{ name: "TOKEN", value: "second-value" }],
				projectKeys: [`git:${"b".repeat(64)}`],
			}),
		]);

		expect(fake.calls.filter((call) => call.args.slice(0, 2).join(" ") === "project create")).toHaveLength(1);
		expect(
			fake.calls.filter(
				(call) =>
					call.args.slice(0, 2).join(" ") === "secret create" &&
					call.args[2] === "Pi credential store · encryption key",
			),
		).toHaveLength(1);
		expect(
			fake.calls.filter(
				(call) =>
					call.args.slice(0, 2).join(" ") === "secret create" &&
					call.args[2] === `${CREDENTIAL_PROFILE_KEY_PREFIX}deploy`,
			),
		).toHaveLength(1);
		expect(fake.calls.filter((call) => call.args.slice(0, 2).join(" ") === "secret edit")).toHaveLength(1);
	});

	it("maps provider failures to bounded errors without forwarding provider output", async () => {
		const leaked = "provider-output-secret-marker";
		const storage = new BitwardenSecretsManagerCredentialStorage({
			coordinationFile,
			resolveTool: async () => ({ status: "available", path: "/managed/bin/bws" }),
			runCommand: async () => ({ exitCode: 1, stdout: leaked, stderr: leaked }),
		});

		const error = await storage.connect("machine-token").then(
			() => undefined,
			(reason: unknown) => reason,
		);
		expect(error).toMatchObject({ code: "provider_command_failed" });
		expect(String(error)).not.toContain(leaked);
	});
});

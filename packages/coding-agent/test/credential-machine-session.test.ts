import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverMachineCredentialSession } from "../src/core/secrets/credential-machine-session.ts";

const roots: string[] = [];

async function root(): Promise<string> {
	const directory = await mkdtemp(join(await realpath(tmpdir()), "pi-machine-session-"));
	roots.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("machine credential session discovery", () => {
	it("prefers a process BWS token without exposing it through metadata", async () => {
		const session = await discoverMachineCredentialSession({
			environment: { BWS_ACCESS_TOKEN: "process-bws-token", BW_SESSION: "password-manager-session" },
			candidateFiles: [],
		});

		expect(session).toEqual({ provider: "bitwarden_secrets_manager", sessionKey: "process-bws-token" });
	});

	it("finds a model-blind BWS bootstrap in a bounded machine file", async () => {
		const machineRoot = await root();
		const file = join(machineRoot, "bitwarden", "bws.env");
		await mkdir(join(machineRoot, "bitwarden"));
		await writeFile(file, "BWS_ACCESS_TOKEN=file-bws-token\nUNRELATED=value\n", { mode: 0o600 });

		const session = await discoverMachineCredentialSession({ environment: {}, candidateFiles: [file] });

		expect(session).toEqual({ provider: "bitwarden_secrets_manager", sessionKey: "file-bws-token" });
	});

	it("falls back to a password-manager session and ignores malformed or oversized files", async () => {
		const machineRoot = await root();
		const malformed = join(machineRoot, "malformed.env");
		const valid = join(machineRoot, "valid.env");
		await writeFile(malformed, `BWS_ACCESS_TOKEN=${"x".repeat(20_000)}\n`, { mode: 0o600 });
		await writeFile(valid, "BW_SESSION=password-manager-session\n", { mode: 0o600 });

		const session = await discoverMachineCredentialSession({
			environment: {},
			candidateFiles: [malformed, valid],
		});

		expect(session).toEqual({
			provider: "bitwarden_password_manager",
			sessionKey: "password-manager-session",
		});
	});

	it("prefers a later Secrets Manager bootstrap over an earlier password-manager file", async () => {
		const machineRoot = await root();
		const passwordManager = join(machineRoot, "bw.env");
		const secretsManager = join(machineRoot, "bws.env");
		await writeFile(passwordManager, "BW_SESSION=password-manager-session\n", { mode: 0o600 });
		await writeFile(secretsManager, "BWS_ACCESS_TOKEN=secrets-manager-session\n", { mode: 0o600 });

		const session = await discoverMachineCredentialSession({
			environment: {},
			candidateFiles: [passwordManager, secretsManager],
		});

		expect(session).toEqual({
			provider: "bitwarden_secrets_manager",
			sessionKey: "secrets-manager-session",
		});
	});
});

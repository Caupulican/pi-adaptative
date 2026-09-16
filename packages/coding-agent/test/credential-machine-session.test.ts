import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	discoverMachineCredentialSession,
	getMachineCredentialBootstrapFiles,
} from "../src/core/secrets/credential-machine-session.ts";

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
	it("loads the existing raw Bitwarden session file from the machine config directory", async () => {
		const machineRoot = await root();
		const file = join(machineRoot, "bitwarden", "session");
		await mkdir(join(machineRoot, "bitwarden"));
		await writeFile(file, "existing-password-manager-session==\n", { mode: 0o600 });
		const environment = { XDG_CONFIG_HOME: machineRoot };
		const candidateFiles = getMachineCredentialBootstrapFiles(join(machineRoot, "agent"), environment);

		expect(candidateFiles).toContain(file);
		await expect(discoverMachineCredentialSession({ environment, candidateFiles })).resolves.toEqual({
			provider: "bitwarden_password_manager",
			sessionKey: "existing-password-manager-session==",
		});
	});

	it("honors BW_SESSION_FILE without treating an arbitrary dotenv file as a raw session", async () => {
		const machineRoot = await root();
		const sessionFile = join(machineRoot, "owner-session");
		const dotenvFile = join(machineRoot, "bw.env");
		await writeFile(sessionFile, "explicit-machine-session\r\n", { mode: 0o600 });
		await writeFile(dotenvFile, "not-a-dotenv-document\n", { mode: 0o600 });
		const environment = { XDG_CONFIG_HOME: machineRoot, BW_SESSION_FILE: sessionFile };
		const candidateFiles = getMachineCredentialBootstrapFiles(join(machineRoot, "agent"), environment);

		await expect(
			discoverMachineCredentialSession({ environment, candidateFiles: [dotenvFile] }),
		).resolves.toBeUndefined();
		expect(candidateFiles).toContain(sessionFile);
		await expect(discoverMachineCredentialSession({ environment, candidateFiles })).resolves.toEqual({
			provider: "bitwarden_password_manager",
			sessionKey: "explicit-machine-session",
		});
	});

	it.each(["", "\n", "one\ntwo\n", "session\0value", "BW_SESSION=value", "x".repeat(20_000)])(
		"rejects malformed or oversized raw session input (%#)",
		async (document) => {
			const machineRoot = await root();
			const file = join(machineRoot, "session");
			await writeFile(file, document, { mode: 0o600 });
			await expect(
				discoverMachineCredentialSession({
					environment: { BW_SESSION_FILE: file },
					candidateFiles: [file],
				}),
			).resolves.toBeUndefined();
		},
	);

	it("does not return a process session after cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			discoverMachineCredentialSession({
				environment: { BW_SESSION: "cancelled-session" },
				signal: controller.signal,
			}),
		).resolves.toBeUndefined();
	});

	it("keeps process and Secrets Manager precedence over a raw password-manager session", async () => {
		const machineRoot = await root();
		const file = join(machineRoot, "session");
		const bwsFile = join(machineRoot, "bws.env");
		await writeFile(file, "file-session\n", { mode: 0o600 });
		await writeFile(bwsFile, "BWS_ACCESS_TOKEN=file-bws-token\n", { mode: 0o600 });
		const candidateFiles = [file, bwsFile];
		await expect(
			discoverMachineCredentialSession({
				environment: { BW_SESSION_FILE: file, BW_SESSION: "process-session" },
				candidateFiles,
			}),
		).resolves.toEqual({ provider: "bitwarden_password_manager", sessionKey: "process-session" });
		await expect(
			discoverMachineCredentialSession({ environment: { BW_SESSION_FILE: file }, candidateFiles }),
		).resolves.toEqual({ provider: "bitwarden_secrets_manager", sessionKey: "file-bws-token" });
	});

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

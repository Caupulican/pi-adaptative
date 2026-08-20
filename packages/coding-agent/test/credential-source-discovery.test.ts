import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CredentialMigrationDiscoveryError,
	discoverCredentialMigrationSources,
} from "../src/core/secrets/credential-source-discovery.ts";

const temporaryRoots: string[] = [];

async function createTemporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-credential-discovery-"));
	temporaryRoots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("credential source discovery", () => {
	it("finds bounded project dotenv and process-environment sources without exposing values", async () => {
		const root = await createTemporaryRoot();
		const secret = "credential-discovery-secret-marker";
		await mkdir(join(root, "config"));
		await mkdir(join(root, "node_modules"));
		await writeFile(join(root, ".env.local"), `API_TOKEN=${secret}\nPORT=3000\n`, { mode: 0o600 });
		await writeFile(join(root, ".env.example"), `EXAMPLE_TOKEN=${secret}\n`, { mode: 0o600 });
		await writeFile(join(root, "config", "credentials.env"), `DEPLOY_PASSWORD=${secret}\n`, { mode: 0o600 });
		await writeFile(join(root, "node_modules", ".env"), `DEPENDENCY_TOKEN=${secret}\n`, { mode: 0o600 });
		if (process.platform !== "win32") {
			const outside = await createTemporaryRoot();
			await writeFile(join(outside, ".env"), `OUTSIDE_TOKEN=${secret}\n`, { mode: 0o600 });
			await symlink(join(outside, ".env"), join(root, ".env.link"));
		}

		const discovered = await discoverCredentialMigrationSources(root, undefined, {
			BW_SESSION: `${secret}-vault-session`,
			DEPLOY_TOKEN: `${secret}-environment`,
			NORMAL_SETTING: secret,
		});

		expect(discovered).toEqual({
			candidates: [
				{
					source: { kind: "environment", name: "DEPLOY_TOKEN" },
					variableNames: ["DEPLOY_TOKEN"],
				},
				{
					source: { kind: "dotenv_file", path: ".env.local" },
					variableNames: ["API_TOKEN", "PORT"],
				},
				{
					source: { kind: "dotenv_file", path: join("config", "credentials.env") },
					variableNames: ["DEPLOY_PASSWORD"],
				},
			],
			skipped: 0,
			truncated: false,
		});
		expect(JSON.stringify(discovered)).not.toContain(secret);
		expect(JSON.stringify(discovered)).not.toContain("BW_SESSION");
		expect(JSON.stringify(discovered)).not.toContain("NORMAL_SETTING");
		expect(JSON.stringify(discovered)).not.toContain("EXAMPLE_TOKEN");
		expect(JSON.stringify(discovered)).not.toContain("DEPENDENCY_TOKEN");
		expect(JSON.stringify(discovered)).not.toContain("OUTSIDE_TOKEN");
	});

	it("reports malformed candidates only as a bounded skipped count", async () => {
		const root = await createTemporaryRoot();
		const secret = "malformed-discovery-secret-marker";
		await writeFile(join(root, ".env"), `TOKEN='${secret}\n`, { mode: 0o600 });

		const discovered = await discoverCredentialMigrationSources(root, undefined, {});

		expect(discovered).toEqual({ candidates: [], skipped: 1, truncated: false });
		expect(JSON.stringify(discovered)).not.toContain(secret);
	});

	it("reserves discovery capacity for project files when the process environment is saturated", async () => {
		const root = await createTemporaryRoot();
		await writeFile(join(root, ".env"), "PROJECT_TOKEN=project-secret\n", { mode: 0o600 });
		const environment = Object.fromEntries(
			Array.from({ length: 40 }, (_, index) => [`TOKEN_${index.toString().padStart(2, "0")}`, `secret-${index}`]),
		);

		const discovered = await discoverCredentialMigrationSources(root, undefined, environment);

		expect(discovered.truncated).toBe(true);
		expect(discovered.candidates.filter((candidate) => candidate.source.kind === "environment")).toHaveLength(32);
		expect(discovered.candidates).toContainEqual({
			source: { kind: "dotenv_file", path: ".env" },
			variableNames: ["PROJECT_TOKEN"],
		});
	});

	it("sweeps additional machine roots while hiding store bootstrap credentials", async () => {
		const cwd = await createTemporaryRoot();
		const machineRoot = await createTemporaryRoot();
		const secret = "machine-discovery-secret-marker";
		await mkdir(join(machineRoot, "bitwarden"));
		await writeFile(join(machineRoot, "bitwarden", "bws.env"), `BWS_ACCESS_TOKEN=${secret}\n`, { mode: 0o600 });
		await writeFile(join(machineRoot, "service.env"), `SERVICE_API_TOKEN=${secret}\n`, { mode: 0o600 });

		const discovered = await discoverCredentialMigrationSources(
			cwd,
			undefined,
			{ BWS_ACCESS_TOKEN: `${secret}-process` },
			{ additionalRoots: [machineRoot] },
		);

		expect(discovered.candidates).toContainEqual({
			source: { kind: "dotenv_file", path: join(machineRoot, "service.env") },
			variableNames: ["SERVICE_API_TOKEN"],
		});
		expect(JSON.stringify(discovered)).not.toContain("BWS_ACCESS_TOKEN");
		expect(JSON.stringify(discovered)).not.toContain("bws.env");
		expect(JSON.stringify(discovered)).not.toContain(secret);
	});

	it("fails closed when discovery is cancelled", async () => {
		const root = await createTemporaryRoot();
		const controller = new AbortController();
		controller.abort();

		await expect(discoverCredentialMigrationSources(root, controller.signal, {})).rejects.toEqual(
			expect.objectContaining<Partial<CredentialMigrationDiscoveryError>>({ code: "discovery_cancelled" }),
		);
	});

	it("does not return a final candidate when cancellation races source inspection", async () => {
		const root = await createTemporaryRoot();
		const controller = new AbortController();
		const environment = {} as NodeJS.ProcessEnv;
		Object.defineProperty(environment, "DEPLOY_TOKEN", {
			enumerable: true,
			get() {
				controller.abort();
				return "cancelled-secret";
			},
		});

		await expect(discoverCredentialMigrationSources(root, controller.signal, environment)).rejects.toEqual(
			expect.objectContaining<Partial<CredentialMigrationDiscoveryError>>({ code: "discovery_cancelled" }),
		);
	});
});

import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CredentialMigrationSourceError,
	resolveCredentialMigrationSources,
} from "../src/core/secrets/credential-migration-source.ts";

const temporaryRoots: string[] = [];

async function createTemporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-credential-migration-"));
	temporaryRoots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("credential migration sources", () => {
	it("loads environment, dotenv, and key-file credentials without changing their sources", async () => {
		const root = await createTemporaryRoot();
		const dotenv = "API_USER=owner@example.com\nAPI_PASSWORD=hidden-password\n";
		const privateKey = "-----BEGIN PRIVATE KEY-----\nhidden-key\n-----END PRIVATE KEY-----\n";
		await writeFile(join(root, ".env.credentials"), dotenv, { mode: 0o600 });
		await writeFile(join(root, "deploy.key"), privateKey, { mode: 0o600 });

		const variables = await resolveCredentialMigrationSources(
			[
				{ kind: "environment", name: "DEPLOY_TOKEN" },
				{ kind: "dotenv_file", path: ".env.credentials" },
				{ kind: "file", path: "deploy.key", variable: "DEPLOY_PRIVATE_KEY" },
			],
			root,
			undefined,
			{ DEPLOY_TOKEN: "hidden-token" },
		);

		expect(variables).toEqual([
			{ name: "DEPLOY_TOKEN", value: "hidden-token" },
			{ name: "API_USER", value: "owner@example.com" },
			{ name: "API_PASSWORD", value: "hidden-password" },
			{ name: "DEPLOY_PRIVATE_KEY", value: privateKey },
		]);
		expect(await readFile(join(root, ".env.credentials"), "utf8")).toBe(dotenv);
		expect(await readFile(join(root, "deploy.key"), "utf8")).toBe(privateKey);
	});

	it("fails closed on unavailable or duplicate sources without exposing values", async () => {
		const root = await createTemporaryRoot();
		const marker = "duplicate-secret-must-not-appear";
		await writeFile(join(root, "duplicate.env"), `TOKEN=${marker}\n`, { mode: 0o600 });

		await expect(
			resolveCredentialMigrationSources([{ kind: "environment", name: "MISSING_TOKEN" }], root, undefined, {}),
		).rejects.toMatchObject({ code: "source_not_found" });
		try {
			await resolveCredentialMigrationSources(
				[
					{ kind: "environment", name: "TOKEN" },
					{ kind: "dotenv_file", path: "duplicate.env" },
				],
				root,
				undefined,
				{ TOKEN: marker },
			);
		} catch (error) {
			expect(error).toBeInstanceOf(CredentialMigrationSourceError);
			expect(error).toMatchObject({ code: "duplicate_variable" });
			expect((error as Error).message).not.toContain(marker);
		}
	});

	it("rejects inherited environment values and oversized key files", async () => {
		const root = await createTemporaryRoot();
		const inheritedMarker = "inherited-secret-must-not-be-read";
		const environment = Object.create({ INHERITED_TOKEN: inheritedMarker }) as NodeJS.ProcessEnv;
		const oversizedPath = join(root, "oversized.key");
		await writeFile(oversizedPath, "x".repeat(64 * 1024 + 1), { mode: 0o600 });

		let inheritedError: unknown;
		try {
			await resolveCredentialMigrationSources(
				[{ kind: "environment", name: "INHERITED_TOKEN" }],
				root,
				undefined,
				environment,
			);
		} catch (error) {
			inheritedError = error;
		}
		expect(inheritedError).toMatchObject({ code: "source_not_found" });
		expect(String(inheritedError)).not.toContain(inheritedMarker);
		await expect(
			resolveCredentialMigrationSources([{ kind: "file", path: oversizedPath, variable: "DEPLOY_KEY" }], root),
		).rejects.toMatchObject({ code: "invalid_source" });
	});
});

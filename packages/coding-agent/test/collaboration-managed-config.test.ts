import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureHerdrManagedConfiguration } from "../src/core/collaboration/herdr-managed-config.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "pi-herdr-config-"));
	directories.push(dir);
	return join(dir, "config.toml");
}

describe("managed Herdr restore authority", () => {
	it("disables native automatic restore and migrates only the exact previous managed configuration", async () => {
		const path = await fixture();
		await ensureHerdrManagedConfiguration(path, true);
		const config = await readFile(path, "utf8");
		expect(config).toContain("resume_agents_on_restore = false");
		await writeFile(path, config.replace("resume_agents_on_restore = false", "resume_agents_on_restore = true"));
		await expect(ensureHerdrManagedConfiguration(path, false)).rejects.toThrow("configuration");
		await ensureHerdrManagedConfiguration(path, true);
		expect(await readFile(path, "utf8")).toBe(config);
		await ensureHerdrManagedConfiguration(path, false);
	});
	it("never overwrites unrecognized configuration or creates configuration during existing-session recovery", async () => {
		const path = await fixture();
		await expect(ensureHerdrManagedConfiguration(path, false)).rejects.toThrow("missing");
		await writeFile(path, "# user change\n[session]\nresume_agents_on_restore = true\n");
		await expect(ensureHerdrManagedConfiguration(path, true)).rejects.toThrow("configuration");
		expect(await readFile(path, "utf8")).toContain("# user change");
	});
});

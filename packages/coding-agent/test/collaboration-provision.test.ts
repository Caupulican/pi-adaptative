import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exposeHerdrOnPath } from "../src/core/collaboration/herdr-provision.ts";

describe("Herdr global command exposure", () => {
	it("keeps the Windows runtime beside its executable and exposes only a command launcher", async () => {
		const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-herdr-windows-path-")));
		try {
			const bin = join(dir, "bin");
			await mkdir(bin);
			const managed = join(dir, "managed-herdr.exe");
			await writeFile(managed, "owned");
			expect(await exposeHerdrOnPath(managed, { path: bin, homeDir: dir, platform: "win32" })).toEqual({
				path: managed,
				globalPath: true,
			});
			expect(await readFile(join(bin, "herdr.cmd"), "utf8")).toContain(`"${managed}" %*`);
			expect(await exposeHerdrOnPath(managed, { path: bin, homeDir: dir, platform: "win32" })).toEqual({
				path: managed,
				globalPath: true,
			});
			await expect(readFile(join(bin, "herdr.exe"))).rejects.toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("exposes an installed binary in an existing user PATH and never overwrites a foreign command", async () => {
		const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-herdr-path-")));
		try {
			const bin = join(dir, "bin");
			await mkdir(bin);
			const managed = join(dir, "managed-herdr");
			await writeFile(managed, "owned", { mode: 0o755 });
			expect(await exposeHerdrOnPath(managed, { path: bin, homeDir: dir, platform: "linux" })).toEqual({
				path: join(bin, "herdr"),
				globalPath: true,
			});
			expect(await realpath(join(bin, "herdr"))).toBe(managed);
			expect(await exposeHerdrOnPath(managed, { path: bin, homeDir: dir, platform: "linux" })).toEqual({
				path: join(bin, "herdr"),
				globalPath: true,
			});
			await rm(join(bin, "herdr"));
			await writeFile(join(bin, "herdr"), "foreign");
			await expect(exposeHerdrOnPath(managed, { path: bin, homeDir: dir, platform: "linux" })).rejects.toThrow(
				"overwrite",
			);
			expect(await readFile(join(bin, "herdr"), "utf8")).toBe("foreign");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("reports unavailable global exposure without editing shell profiles or unowned directories", async () => {
		const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-herdr-path-")));
		try {
			const managed = join(dir, "herdr");
			await writeFile(managed, "owned");
			expect(await exposeHerdrOnPath(managed, { path: "/usr/bin", homeDir: dir, platform: "linux" })).toEqual({
				path: managed,
				globalPath: false,
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

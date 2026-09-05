import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
	it("exposes an installed binary in the native user PATH and never overwrites a foreign command", async () => {
		const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-herdr-path-")));
		try {
			const bin = join(dir, "bin");
			await mkdir(bin);
			const windows = process.platform === "win32";
			const managed = join(dir, windows ? "managed-herdr.exe" : "managed-herdr");
			const command = join(bin, windows ? "herdr.cmd" : "herdr");
			const options = { path: bin, homeDir: dir };
			await writeFile(managed, "owned", { mode: 0o755 });
			expect(await exposeHerdrOnPath(managed, options)).toEqual({
				path: windows ? managed : command,
				globalPath: true,
			});
			if (windows) expect(await readFile(command, "utf8")).toContain(`"${managed}" %*`);
			else expect(await realpath(command)).toBe(managed);
			expect(await exposeHerdrOnPath(managed, options)).toEqual({
				path: windows ? managed : command,
				globalPath: true,
			});
			await rm(command);
			await writeFile(command, "foreign");
			await expect(exposeHerdrOnPath(managed, options)).rejects.toThrow("overwrite");
			expect(await readFile(command, "utf8")).toBe("foreign");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("reports unavailable global exposure without editing shell profiles or unowned directories", async () => {
		const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-herdr-path-")));
		try {
			const homeDir = join(dir, "home");
			const unownedBin = join(dir, "unowned-bin");
			await mkdir(homeDir);
			await mkdir(unownedBin);
			const managed = join(dir, "herdr");
			await writeFile(managed, "owned");
			expect(await exposeHerdrOnPath(managed, { path: unownedBin, homeDir })).toEqual({
				path: managed,
				globalPath: false,
			});
			expect(await readdir(unownedBin)).toEqual([]);
			expect(await readdir(homeDir)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

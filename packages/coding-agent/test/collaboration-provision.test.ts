import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	checkHerdrInstallation,
	exposeHerdrOnPath,
	provisionHerdr,
	runHerdrProvisionCommand,
} from "../src/core/collaboration/herdr-provision.ts";
import { ensureToolWithDiagnostics } from "../src/utils/tools-manager.ts";

vi.mock("../src/utils/tools-manager.ts", () => ({ ensureToolWithDiagnostics: vi.fn() }));

describe("Herdr installation progress", () => {
	it("uses the existing bounded download owner and makes explicit install progress visible", async () => {
		const ensure = vi.mocked(ensureToolWithDiagnostics);
		ensure.mockResolvedValue({ status: "unavailable", failureCode: "offline", message: "Offline mode enabled" });
		await expect(provisionHerdr({ silent: false })).rejects.toThrow("offline");
		expect(ensure).toHaveBeenLastCalledWith("herdr", false);
		// Negative control: lazy runtime provisioning retains its silent default.
		await expect(provisionHerdr()).rejects.toThrow("offline");
		expect(ensure).toHaveBeenLastCalledWith("herdr", true);
	});

	it.each(["offline", "installation_failed", "unsupported_platform"] as const)(
		"reports %s honestly without failing the optional installer command",
		async (failureCode) => {
			vi.mocked(ensureToolWithDiagnostics).mockResolvedValue({
				status: "unavailable",
				failureCode,
				message: "bounded failure",
			});
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			try {
				await expect(runHerdrProvisionCommand()).resolves.toBeUndefined();
				const text = log.mock.calls.flat().join("\n");
				expect(text).toContain("[WARN] Herdr");
				expect(text).toContain(failureCode);
				expect(text).toContain("Pi remains usable");
				expect(text).not.toContain("[OK]");
			} finally {
				log.mockRestore();
			}
		},
	);

	it("fresh/existing success reports availability, not an invented installation outcome", async () => {
		const provision = vi.fn(async () => ({ path: "/managed/herdr", globalPath: false }));
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await checkHerdrInstallation({ silent: false }, provision);
			expect(result).toEqual({ present: true, detail: "/managed/herdr (managed binary; not exposed on PATH)" });
		}
		expect(provision).toHaveBeenCalledTimes(2);
	});
});

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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	getManagedToolBinaryPath,
	getPinnedToolAsset,
	getToolDownloadKind,
	installToolArchiveDirectory,
} from "../src/utils/tools-manager.ts";

describe("managed collaboration backend release", () => {
	it("preserves Windows app-local runtime and licenses in one atomic directory installation", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-directory-"));
		try {
			const extracted = join(dir, "extracted");
			mkdirSync(join(extracted, "conpty", "x64"), { recursive: true });
			writeFileSync(join(extracted, "herdr.exe"), "binary");
			writeFileSync(join(extracted, "conpty", "conpty.dll"), "runtime");
			writeFileSync(join(extracted, "conpty", "x64", "OpenConsole.exe"), "console");
			const binary = getManagedToolBinaryPath("herdr", "win32", join(dir, "bin"));
			expect(binary).toBe(join(dir, "bin", "herdr-0.8.2", "herdr.exe"));
			installToolArchiveDirectory(join(extracted, "herdr.exe"), binary);
			expect(readFileSync(join(dir, "bin", "herdr-0.8.2", "conpty", "conpty.dll"), "utf8")).toBe("runtime");
			expect(getManagedToolBinaryPath("jq", "win32", join(dir, "bin"))).toBe(join(dir, "bin", "jq.exe"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it.each([
		["linux", "x64", "herdr-linux-x86_64"],
		["linux", "arm64", "herdr-linux-aarch64"],
		["darwin", "x64", "herdr-macos-x86_64"],
		["darwin", "arm64", "herdr-macos-aarch64"],
		["win32", "x64", "herdr-windows-x86_64.zip"],
	])("pins a verified asset for %s/%s", (platform, arch, asset) => {
		expect(getPinnedToolAsset("herdr", platform, arch)).toEqual({
			version: "0.8.2",
			assetName: asset,
			expectedSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(getToolDownloadKind("herdr", platform)).toBe(platform === "win32" ? "archive" : "binary");
	});
	it("does not invent unsupported packages or change existing archive/binary policies", () => {
		expect(getPinnedToolAsset("herdr", "win32", "arm64")).toBeNull();
		expect(getPinnedToolAsset("herdr", "android", "arm64")).toBeNull();
		expect(getToolDownloadKind("uv", "linux")).toBe("archive");
		expect(getToolDownloadKind("jq", "win32")).toBe("binary");
	});
});

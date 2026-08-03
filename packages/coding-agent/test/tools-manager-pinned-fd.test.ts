import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FD_VERSION, getPinnedToolAsset } from "../src/utils/tools-manager.ts";

describe("managed fd release", () => {
	it("has no managed-tool path through GitHub's rate-limited latest-release API", () => {
		const source = readFileSync(new URL("../src/utils/tools-manager.ts", import.meta.url), "utf8");
		expect(source).not.toContain("api.github.com/repos");
		expect(source).not.toContain("getLatestVersion");
	});

	it("uses verified pinned assets on both Windows architectures without a latest-release API lookup", () => {
		expect(getPinnedToolAsset("fd", "win32", "x64")).toEqual({
			version: FD_VERSION,
			assetName: `fd-v${FD_VERSION}-x86_64-pc-windows-msvc.zip`,
			expectedSha256: "b2816e506390a89941c63c9187d58a3cc10e9a55f2ef0685f9ea0eccaf7c98c8",
		});
		expect(getPinnedToolAsset("fd", "win32", "arm64")).toEqual({
			version: FD_VERSION,
			assetName: `fd-v${FD_VERSION}-aarch64-pc-windows-msvc.zip`,
			expectedSha256: "4f9110c2d5b33a7f760bfa5510f4c113d828109f7277d421b1053a9943c0fc92",
		});
	});

	it("keeps every supported managed target checksum-gated, including the last Intel macOS release", () => {
		for (const [targetPlatform, targetArchitecture] of [
			["darwin", "arm64"],
			["darwin", "x64"],
			["linux", "arm64"],
			["linux", "x64"],
			["win32", "arm64"],
			["win32", "x64"],
		] as const) {
			expect(getPinnedToolAsset("fd", targetPlatform, targetArchitecture)).not.toBeNull();
		}
	});

	it("does not invent an asset for an unsupported architecture", () => {
		expect(getPinnedToolAsset("fd", "win32", "ia32")).toBeNull();
	});
});

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
			expectedSha256: "a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7",
		});
		expect(getPinnedToolAsset("fd", "win32", "arm64")).toEqual({
			version: FD_VERSION,
			assetName: `fd-v${FD_VERSION}-aarch64-pc-windows-msvc.zip`,
			expectedSha256: "a2bcddcfd259b05357a77bbc6cd671fdb30f63fd266a0e748305890a8c5ceaa6",
		});
	});

	it("keeps every supported managed target checksum-gated, at the same release on Intel macOS", () => {
		for (const [targetPlatform, targetArchitecture] of [
			["darwin", "arm64"],
			["darwin", "x64"],
			["linux", "arm64"],
			["linux", "x64"],
			["win32", "arm64"],
			["win32", "x64"],
		] as const) {
			expect(getPinnedToolAsset("fd", targetPlatform, targetArchitecture)).toMatchObject({
				version: "10.5.0",
				expectedSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			});
		}
	});

	it("does not invent an asset for an unsupported architecture", () => {
		expect(getPinnedToolAsset("fd", "win32", "ia32")).toBeNull();
	});
});

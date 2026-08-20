import { describe, expect, it } from "vitest";
import {
	BITWARDEN_CLI_VERSION,
	BITWARDEN_SECRETS_MANAGER_CLI_VERSION,
	getPinnedToolAsset,
} from "../src/utils/tools-manager.ts";

describe("managed Bitwarden CLI release", () => {
	it("pins the official checksummed desktop archives Pi can install", () => {
		expect(getPinnedToolAsset("bw", "linux", "x64")).toEqual({
			version: BITWARDEN_CLI_VERSION,
			assetName: `bw-linux-${BITWARDEN_CLI_VERSION}.zip`,
			expectedSha256: "7a35145e205952f7434d2370da359543145ae0c45ba1af0fe9bdd99d40a00180",
		});
		expect(getPinnedToolAsset("bw", "linux", "arm64")?.expectedSha256).toBe(
			"e33ed05ca0fada9bd51b8bce76a230369bf0eefd5796a0a8e60699c977327fb5",
		);
		expect(getPinnedToolAsset("bw", "darwin", "x64")?.expectedSha256).toBe(
			"b37836d539798f5adeb8a907619ee8a55b6322549bb68669aa4b3a03d5bc0452",
		);
		expect(getPinnedToolAsset("bw", "darwin", "arm64")?.expectedSha256).toBe(
			"61d5de8a279a9faf3637216f4fb02b506a1e4bb2817d1c64be0bd474466dd85a",
		);
		expect(getPinnedToolAsset("bw", "win32", "x64")?.expectedSha256).toBe(
			"b0c22438607b789c6452dbd37ffd6be0e8a61e7a5c4e9ac57804d7ae5ed01b5b",
		);
		for (const [targetPlatform, targetArchitecture] of [
			["linux", "x64"],
			["linux", "arm64"],
			["darwin", "x64"],
			["darwin", "arm64"],
			["win32", "x64"],
		] as const) {
			expect(getPinnedToolAsset("bw", targetPlatform, targetArchitecture)?.expectedSha256).toMatch(/^[a-f0-9]{64}$/);
		}
	});

	it("does not invent an upstream archive for Windows arm64", () => {
		expect(getPinnedToolAsset("bw", "win32", "arm64")).toBeNull();
	});

	it("pins official Secrets Manager archives for every release target", () => {
		expect(getPinnedToolAsset("bws", "linux", "x64")).toEqual({
			version: BITWARDEN_SECRETS_MANAGER_CLI_VERSION,
			assetName: `bws-x86_64-unknown-linux-musl-${BITWARDEN_SECRETS_MANAGER_CLI_VERSION}.zip`,
			expectedSha256: "f59ee150e42b82128d437087e9bac920053c6bfddcb960d20ce9386e5ac9bba6",
		});
		for (const [targetPlatform, targetArchitecture] of [
			["linux", "x64"],
			["linux", "arm64"],
			["darwin", "x64"],
			["darwin", "arm64"],
			["win32", "x64"],
			["win32", "arm64"],
		] as const) {
			expect(getPinnedToolAsset("bws", targetPlatform, targetArchitecture)?.expectedSha256).toMatch(
				/^[a-f0-9]{64}$/,
			);
		}
	});
});

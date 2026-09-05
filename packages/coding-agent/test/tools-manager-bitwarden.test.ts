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
			expectedSha256: "367f618e9fcccaac4980ec12c7bafd01df739b5f3cb1af31bc9045cf75eea1d6",
		});
		expect(getPinnedToolAsset("bw", "linux", "arm64")?.expectedSha256).toBe(
			"74d822a5dceda5896ed8fc07bc61925b29afd98d96a6a3e9e525ae556c3083a8",
		);
		expect(getPinnedToolAsset("bw", "darwin", "x64")?.expectedSha256).toBe(
			"c5d57f70d5394f8c348f6c3bf53683ad6d15e6acfe55e7c1e0a8f376482d8e71",
		);
		expect(getPinnedToolAsset("bw", "darwin", "arm64")?.expectedSha256).toBe(
			"73414942357644605eefd3f4afaf0b41b71772ad6574e8e3c72e0b6d237104c8",
		);
		expect(getPinnedToolAsset("bw", "win32", "x64")?.expectedSha256).toBe(
			"26a6bb9a88ca9eeaad9e59db1816dcceb3ce6cc80a30b33e1324b0642f4a0f32",
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

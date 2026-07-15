import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getPinnedToolAsset, UV_VERSION, verifyFileSha256 } from "../src/utils/tools-manager.ts";

const tempDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("managed uv release", () => {
	it("pins deterministic checksummed assets for supported desktop targets", () => {
		expect(getPinnedToolAsset("uv", "linux", "x64")).toEqual({
			version: UV_VERSION,
			assetName: "uv-x86_64-unknown-linux-musl.tar.gz",
			expectedSha256: "f02146b371c35c287d860f003ece7345c86e358a3fd70a9b63700cd141ee7fb4",
		});
		expect(getPinnedToolAsset("uv", "linux", "arm64")?.assetName).toBe("uv-aarch64-unknown-linux-musl.tar.gz");
		expect(getPinnedToolAsset("uv", "darwin", "arm64")?.assetName).toBe("uv-aarch64-apple-darwin.tar.gz");
		expect(getPinnedToolAsset("uv", "win32", "x64")?.assetName).toBe("uv-x86_64-pc-windows-msvc.zip");
	});

	it("does not claim an upstream desktop archive works on Android or unsupported architectures", () => {
		expect(getPinnedToolAsset("uv", "android", "arm64")).toBeNull();
		expect(getPinnedToolAsset("uv", "linux", "riscv64")).toBeNull();
	});

	it("verifies downloaded archives without loading the complete file into memory", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-uv-hash-"));
		tempDirectories.push(directory);
		const file = join(directory, "asset.tar.gz");
		const content = Buffer.alloc(256 * 1024, 0x61);
		await writeFile(file, content);
		const expected = createHash("sha256").update(content).digest("hex");
		await expect(verifyFileSha256(file, expected)).resolves.toBe(true);
		await expect(verifyFileSha256(file, "0".repeat(64))).resolves.toBe(false);
	});
});

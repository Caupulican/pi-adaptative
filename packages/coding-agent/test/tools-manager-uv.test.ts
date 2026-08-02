import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getPinnedToolAsset,
	installStandaloneBinaryAsset,
	JQ_VERSION,
	RG_VERSION,
	UV_VERSION,
	verifyFileSha256,
} from "../src/utils/tools-manager.ts";

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

describe("managed search and JSON tools", () => {
	it("pins checksummed ripgrep archives for every supported desktop target", () => {
		expect(getPinnedToolAsset("rg", "linux", "x64")).toEqual({
			version: RG_VERSION,
			assetName: "ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz",
			expectedSha256: "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
		});
		expect(getPinnedToolAsset("rg", "linux", "arm64")?.expectedSha256).toBe(
			"a740b91c82eaf9914cfedd353572f2791cbe0162c84101ee0951058f4dcbc90d",
		);
		expect(getPinnedToolAsset("rg", "darwin", "x64")?.expectedSha256).toBe(
			"af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1",
		);
		expect(getPinnedToolAsset("rg", "win32", "arm64")?.expectedSha256).toBe(
			"e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f",
		);
	});

	it("pins checksummed standalone jq binaries for every supported desktop target", () => {
		expect(getPinnedToolAsset("jq", "linux", "x64")).toEqual({
			version: JQ_VERSION,
			assetName: "jq-linux-amd64",
			expectedSha256: "b1c22172dd303f3be49e935aa56aa48a8b7a46e0bc838b4997d3bb451495870f",
		});
		expect(getPinnedToolAsset("jq", "linux", "arm64")?.expectedSha256).toBe(
			"8b85c817833814ddca00a144c33705546355afccf0cf39b188f3cdb48b852309",
		);
		expect(getPinnedToolAsset("jq", "darwin", "arm64")?.expectedSha256).toBe(
			"2d75340ba57a4b4b4c8708a21c2dc8e958a48aaa8bba13b27f77f6e4c0eca07e",
		);
		expect(getPinnedToolAsset("jq", "win32", "arm64")?.expectedSha256).toBe(
			"083b5377392bc57cf27052b6d20a2d927770683bca844632901ff38b4b7b0ac7",
		);
	});

	it("installs a verified standalone asset without archive extraction", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-jq-binary-"));
		tempDirectories.push(directory);
		const downloaded = join(directory, "jq-linux-amd64");
		const installed = join(directory, "bin", "jq");
		await writeFile(downloaded, "standalone-jq");

		installStandaloneBinaryAsset(downloaded, installed, "linux");

		await expect(readFile(installed, "utf-8")).resolves.toBe("standalone-jq");
		expect((await stat(installed)).mode & 0o111).not.toBe(0);
	});
});

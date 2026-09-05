import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ensureManagedJscpd,
	installBundledJscpdBinary,
	JSCPD_VERSION,
	resolveJscpdPlatformPackage,
} from "../src/utils/bundled-jscpd.ts";

const tempDirs: string[] = [];

async function tempDir(name: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), name));
	tempDirs.push(path);
	return path;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("bundled jscpd", () => {
	it("pins the Rust v5 package for every supported release target", () => {
		expect(JSCPD_VERSION).toMatch(/^5\.\d+\.\d+$/);
		expect(resolveJscpdPlatformPackage("linux", "x64", "glibc")).toBe("jscpd-linux-x64-gnu");
		expect(resolveJscpdPlatformPackage("linux", "x64", "musl")).toBe("jscpd-linux-x64-musl");
		expect(resolveJscpdPlatformPackage("linux", "arm64", "glibc")).toBe("jscpd-linux-arm64-gnu");
		expect(resolveJscpdPlatformPackage("linux", "arm64", "musl")).toBeUndefined();
		expect(resolveJscpdPlatformPackage("darwin", "arm64")).toBe("jscpd-darwin-arm64");
		expect(resolveJscpdPlatformPackage("darwin", "x64")).toBe("jscpd-darwin-x64");
		expect(resolveJscpdPlatformPackage("win32", "x64")).toBe("jscpd-windows-x64-msvc");
		expect(resolveJscpdPlatformPackage("win32", "arm64")).toBe("jscpd-windows-x64-msvc");
	});

	it.each([
		["linux", "ia32"],
		["win32", "ia32"],
		["darwin", "riscv64"],
		["freebsd", "x64"],
	])("rejects unsupported native scanner target %s/%s", (targetPlatform, targetArchitecture) => {
		expect(resolveJscpdPlatformPackage(targetPlatform, targetArchitecture)).toBeUndefined();
	});

	it("copies only into Pi managed storage and leaves the repository untouched", async () => {
		const root = await tempDir("pi-jscpd-zero-footprint-");
		const repo = join(root, "repo");
		const source = join(root, "source-jscpd");
		const managedBin = join(root, "agent", "bin");
		await writeFile(join(root, "keep"), "sentinel", "utf8");
		await writeFile(source, "binary", "utf8");
		await chmod(source, 0o755);
		await writeFile(repo, "project", "utf8");
		const before = await readdir(root);

		const installed = installBundledJscpdBinary({
			sourcePath: source,
			sourceVersion: JSCPD_VERSION,
			managedBinDir: managedBin,
			targetPlatform: "linux",
			probeVersion: () => `cpd ${JSCPD_VERSION}`,
		});

		expect(installed).toBe(join(managedBin, "jscpd"));
		expect(await readFile(installed, "utf8")).toBe("binary");
		expect(await readFile(repo, "utf8")).toBe("project");
		expect((await readdir(root)).filter((name) => name !== "agent")).toEqual(before);
	});

	it("rejects a mismatched bundled version without retaining a target", async () => {
		const root = await tempDir("pi-jscpd-version-");
		const source = join(root, "jscpd");
		const managedBin = join(root, "bin");
		await writeFile(source, "wrong", "utf8");

		expect(() =>
			installBundledJscpdBinary({
				sourcePath: source,
				sourceVersion: "4.0.0",
				managedBinDir: managedBin,
				targetPlatform: "linux",
				probeVersion: () => "cpd 4.0.0",
			}),
		).toThrow(`requires bundled jscpd ${JSCPD_VERSION}`);
		await expect(readFile(join(managedBin, "jscpd"))).rejects.toThrow();
	});

	it("keeps managed installations isolated across sibling agent directories", async () => {
		const root = await tempDir("pi-jscpd-isolation-");
		const executable = process.platform === "win32" ? "jscpd.exe" : "jscpd";
		const firstBin = join(root, "agent", "bin-extra");
		const secondBin = join(root, "agent", "bin");

		expect(ensureManagedJscpd(firstBin)).toBe(join(firstBin, executable));
		expect(ensureManagedJscpd(secondBin)).toBe(join(secondBin, executable));
	});

	it("ships the dependency, CLI wrapper, standalone binaries, and zero-footprint skill contract", async () => {
		const packageRoot = resolve(import.meta.dirname, "..");
		const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
			bin?: Record<string, string>;
			dependencies?: Record<string, string>;
		};
		expect(manifest.dependencies?.jscpd).toBe(JSCPD_VERSION);
		expect(manifest.bin?.jscpd).toBe("dist/jscpd-cli.js");

		const buildScript = await readFile(resolve(packageRoot, "..", "..", "scripts", "build-binaries.sh"), "utf8");
		expect(buildScript).toContain("dependencies.jscpd");
		expect(buildScript.indexOf("JSCPD_VERSION=$(node")).toBeLessThan(
			buildScript.indexOf('if [[ "$SKIP_DEPS" == "false" ]]'),
		);
		expect(buildScript).toContain('jscpd-windows-x64-msvc@"$JSCPD_VERSION"');
		expect(buildScript).toContain("bundled-tools/jscpd");

		const skill = await readFile(
			join(packageRoot, "src", "bundled-resources", "skills", "deduplicate-by-evidence", "SKILL.md"),
			"utf8",
		);
		expect(skill).toContain("Pi-managed jscpd v5");
		expect(skill).toContain("never install jscpd into the project");
		expect(skill).not.toMatch(/\bnpx\s+jscpd\b/);
	});
});

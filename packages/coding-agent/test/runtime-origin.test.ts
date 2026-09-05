import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { RuntimeArtifactStore } from "../src/cli/runtime-artifact-store.ts";
import { createStandaloneRuntimeOrigin } from "../src/cli/runtime-origin.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(["linux", "win32"] as const)(
	"captures the activated %s release without changing retained targets",
	async (platform) => {
		const root = await mkdtemp(join(tmpdir(), "pi-runtime-origin-"));
		roots.push(root);
		const binary = platform === "win32" ? "pi.exe" : "pi";
		for (const version of ["v1.0.0", "v1.0.1"]) {
			const release = join(root, "releases", version);
			await mkdir(release, { recursive: true });
			await writeFile(join(release, binary), version);
			await writeFile(join(release, ".pi-adaptative-managed"), "pi-adaptative-managed-release-v1\n");
		}
		const activate = async (version: string) => {
			if (platform === "win32") await writeFile(join(root, "current.version"), `${version}\r\n`);
			else {
				await rm(join(root, "current"), { force: true });
				await symlink(join(root, "releases", version), join(root, "current"), "junction");
			}
		};
		await activate("v1.0.0");
		if (platform === "win32") {
			await mkdir(join(root, "bin"));
			await writeFile(
				join(root, "bin", "pi.cmd"),
				`@echo off\r\nREM PI_ADAPTATIVE_MANAGED_LAUNCHER\r\nset "PI_ADAPTATIVE_ROOT=${root}"\r\n`,
			);
		}
		const firstRoot = join(root, "releases", "v1.0.0");
		const source = await createStandaloneRuntimeOrigin(
			firstRoot,
			{ executable: join(firstRoot, binary), argsPrefix: [] },
			platform,
		);
		const artifacts = join(root, "artifacts");
		await mkdir(artifacts);
		const store = new RuntimeArtifactStore(source.capture, artifacts);
		const previous = await store.capture();
		expect(source.stableTarget?.executable).toBe(
			join(await realpath(root), platform === "win32" ? "bin" : "current", platform === "win32" ? "pi.cmd" : "pi"),
		);
		await activate("v1.0.1");
		const candidate = await store.capture();
		expect(await readFile(store.target(previous).executable, "utf8")).toBe("v1.0.0");
		expect(await readFile(store.target(candidate).executable, "utf8")).toBe("v1.0.1");
		await rm(firstRoot, { recursive: true });
		expect(source.stableTarget?.executable).not.toContain("v1.0.0");
		if (platform !== "win32") expect(await readFile(source.stableTarget!.executable, "utf8")).toBe("v1.0.1");
		await activate("../escape");
		await expect(store.capture()).rejects.toThrow();
		expect(await readFile(store.target(previous).executable, "utf8")).toBe("v1.0.0");
	},
);

it("does not pin an unproven Windows release and resolves only its owned custom-bin launcher", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-runtime-launcher-"));
	roots.push(root);
	const release = join(root, "releases", "v1.0.0");
	const bin = join(root, "custom-bin");
	await mkdir(release, { recursive: true });
	await mkdir(bin);
	await writeFile(join(release, ".pi-adaptative-managed"), "pi-adaptative-managed-release-v1\n");
	const target = { executable: join(release, "pi.exe"), argsPrefix: [] };
	expect((await createStandaloneRuntimeOrigin(release, target, "win32", {})).stableTarget).toBeUndefined();
	await writeFile(join(bin, "pi.cmd"), `REM PI_ADAPTATIVE_MANAGED_LAUNCHER\nset "PI_ADAPTATIVE_ROOT=foreign"\n`);
	expect(
		(await createStandaloneRuntimeOrigin(release, target, "win32", { PI_BIN_DIR: bin })).stableTarget,
	).toBeUndefined();
	await writeFile(join(bin, "pi.cmd"), `REM PI_ADAPTATIVE_MANAGED_LAUNCHER\nset "PI_ADAPTATIVE_ROOT=${root}"\n`);
	expect((await createStandaloneRuntimeOrigin(release, target, "win32", { PI_BIN_DIR: bin })).stableTarget).toEqual({
		executable: join(bin, "pi.cmd"),
		argsPrefix: [],
	});
});

it("recognizes the same Windows install through a path alias but rejects a different install", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-runtime-origin-alias-"));
	roots.push(root);
	const install = join(root, "install%name");
	const alias = join(root, "alias");
	const release = join(install, "releases", "v1.0.0");
	const bin = join(root, "bin");
	await mkdir(release, { recursive: true });
	await mkdir(bin);
	await symlink(install, alias, "junction");
	await writeFile(join(release, ".pi-adaptative-managed"), "pi-adaptative-managed-release-v1\n");
	const target = { executable: join(release, "pi.exe"), argsPrefix: [] };
	const launcher = join(bin, "pi.cmd");
	await writeFile(launcher, `REM PI_ADAPTATIVE_MANAGED_LAUNCHER\nset "PI_ADAPTATIVE_ROOT=${alias}"\n`);
	expect((await createStandaloneRuntimeOrigin(release, target, "win32", { PI_BIN_DIR: bin })).stableTarget).toEqual({
		executable: launcher,
		argsPrefix: [],
	});
	await writeFile(
		launcher,
		`REM PI_ADAPTATIVE_MANAGED_LAUNCHER\nset "PI_ADAPTATIVE_ROOT=${install.replaceAll("%", "%%")}"\n`,
	);
	expect(
		(await createStandaloneRuntimeOrigin(release, target, "win32", { PI_BIN_DIR: bin })).stableTarget?.executable,
	).toBe(launcher);
	await writeFile(launcher, `REM PI_ADAPTATIVE_MANAGED_LAUNCHER\nset "PI_ADAPTATIVE_ROOT=${root}"\n`);
	expect(
		(await createStandaloneRuntimeOrigin(release, target, "win32", { PI_BIN_DIR: bin })).stableTarget,
	).toBeUndefined();
});

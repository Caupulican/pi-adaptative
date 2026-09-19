import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * Covers the provisioning step that makes FFF native search work inside a release binary.
 *
 * `ffi-rs/index.js` prefers `require("./ffi-rs.<triple>.node")` and only falls back to the scoped
 * `@yuuang/ffi-rs-<triple>` package when that file is absent. Releases are built with
 * `bun build --compile`, and inside that executable the scoped fallback does not resolve from an
 * external node_modules tree — the load fails with `Cannot find module '@yuuang/ffi-rs-<triple>'`
 * even though npm installed it, so the doctor reported FFF as missing on a machine where the
 * install had in fact succeeded. Running from source on Node takes the scoped path and works,
 * which is why only shipped binaries were affected.
 */

async function withFreshManagedDir<T>(fn: (managedDir: string) => Promise<T>): Promise<T> {
	const tempAgentDir = mkdtempSync(join(tmpdir(), "pi-agent-fff-staging-"));
	vi.resetModules();
	const config = await import("../src/config.ts");
	const envKey = config.ENV_AGENT_DIR;
	const previous = process.env[envKey];
	process.env[envKey] = tempAgentDir;
	try {
		vi.resetModules();
		const { getBinDir } = await import("../src/config.ts");
		return await fn(join(getBinDir(), "fff-node"));
	} finally {
		if (previous === undefined) delete process.env[envKey];
		else process.env[envKey] = previous;
		rmSync(tempAgentDir, { recursive: true, force: true });
	}
}

function seedManagedTree(
	managedDir: string,
	bindings: Record<string, string>,
	options: { withFfiRsDir?: boolean } = {},
): void {
	const modules = join(managedDir, "node_modules");
	if (options.withFfiRsDir !== false) mkdirSync(join(modules, "ffi-rs"), { recursive: true });
	for (const [packageName, files] of Object.entries(bindings)) {
		const packageDir = join(modules, "@yuuang", packageName);
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(join(packageDir, files), `binary:${files}`);
		writeFileSync(join(packageDir, "package.json"), `{"name":"@yuuang/${packageName}","main":"${files}"}`);
	}
}

describe("tools-manager: ffi-rs native binding staging", () => {
	it("copies every installed platform binding next to ffi-rs so a compiled binary resolves it", async () => {
		await withFreshManagedDir(async (managedDir) => {
			seedManagedTree(managedDir, {
				"ffi-rs-linux-x64-gnu": "ffi-rs.linux-x64-gnu.node",
				"ffi-rs-linux-x64-musl": "ffi-rs.linux-x64-musl.node",
			});
			const { stageFfiRsNativeBindings } = await import("../src/utils/tools-manager.ts");

			stageFfiRsNativeBindings();

			const ffiRsDir = join(managedDir, "node_modules", "ffi-rs");
			// Copied by exact filename: ffi-rs looks each triple up by its own name, so no platform
			// table is duplicated in the installer.
			expect(readFileSync(join(ffiRsDir, "ffi-rs.linux-x64-gnu.node"), "utf8")).toBe(
				"binary:ffi-rs.linux-x64-gnu.node",
			);
			expect(readFileSync(join(ffiRsDir, "ffi-rs.linux-x64-musl.node"), "utf8")).toBe(
				"binary:ffi-rs.linux-x64-musl.node",
			);
			// Only the native bindings move; the scoped package's own manifest stays where it is.
			expect(existsSync(join(ffiRsDir, "package.json"))).toBe(false);

			// Simulate an installation left by an older release: the package-native binding remains,
			// but staging is absent. Offline recovery must stage before its initial load attempt.
			const staged = join(ffiRsDir, "ffi-rs.linux-x64-gnu.node");
			rmSync(staged);
			const loaded = { FileFinder: class {} };
			const requireFff = ((id: string) => {
				if (id !== "@ff-labs/fff-node" || !existsSync(staged)) throw new Error("native binding is not staged");
				return loaded;
			}) as NodeJS.Require;
			const previousOffline = process.env.PI_OFFLINE;
			process.env.PI_OFFLINE = "1";
			try {
				const { ensureFffNodePackage } = await import("../src/utils/tools-manager.ts");

				await expect(ensureFffNodePackage(true, false, [requireFff])).resolves.toBe(loaded);
				expect(readFileSync(staged, "utf8")).toBe("binary:ffi-rs.linux-x64-gnu.node");
			} finally {
				if (previousOffline === undefined) delete process.env.PI_OFFLINE;
				else process.env.PI_OFFLINE = previousOffline;
			}
		});
	});

	it("keeps a genuinely missing managed binding closed while offline", async () => {
		await withFreshManagedDir(async () => {
			const requireFff = (() => {
				throw new Error("native binding is missing");
			}) as unknown as NodeJS.Require;
			const previousOffline = process.env.PI_OFFLINE;
			process.env.PI_OFFLINE = "1";
			try {
				const { ensureFffNodePackage, getLastFffInstallOutcome } = await import("../src/utils/tools-manager.ts");

				await expect(ensureFffNodePackage(true, false, [requireFff])).resolves.toBeUndefined();
				expect(getLastFffInstallOutcome()).toEqual({ status: "offline" });
			} finally {
				if (previousOffline === undefined) delete process.env.PI_OFFLINE;
				else process.env.PI_OFFLINE = previousOffline;
			}
		});
	});

	it("keeps staging filesystem failures fail-soft for alternate loads and offline fallback", async () => {
		await withFreshManagedDir(async (managedDir) => {
			seedManagedTree(managedDir, { "ffi-rs-linux-x64-gnu": "ffi-rs.linux-x64-gnu.node" });
			const stagingError = new Error("deterministic staging stat failure");
			const throwStagingFilesystemError = vi.fn(() => {
				throw stagingError;
			});
			const previousOffline = process.env.PI_OFFLINE;
			process.env.PI_OFFLINE = "1";
			try {
				vi.resetModules();
				const { ensureFffNodePackage, getLastFffInstallOutcome } = await import("../src/utils/tools-manager.ts");
				const loaded = { FileFinder: class {} };
				const availableRequire = (() => loaded) as unknown as NodeJS.Require;
				const missingRequire = (() => {
					throw new Error("module unavailable");
				}) as unknown as NodeJS.Require;

				await expect(
					ensureFffNodePackage(true, false, [availableRequire], throwStagingFilesystemError),
				).resolves.toBe(loaded);
				await expect(
					ensureFffNodePackage(true, false, [missingRequire], throwStagingFilesystemError),
				).resolves.toBeUndefined();
				expect(throwStagingFilesystemError).toHaveBeenCalledTimes(2);
				expect(getLastFffInstallOutcome()).toEqual({ status: "offline" });
			} finally {
				vi.resetModules();
				if (previousOffline === undefined) delete process.env.PI_OFFLINE;
				else process.env.PI_OFFLINE = previousOffline;
			}
		});
	});

	it("never overwrites a binding ffi-rs already ships", async () => {
		await withFreshManagedDir(async (managedDir) => {
			seedManagedTree(managedDir, { "ffi-rs-linux-x64-gnu": "ffi-rs.linux-x64-gnu.node" });
			const existing = join(managedDir, "node_modules", "ffi-rs", "ffi-rs.linux-x64-gnu.node");
			writeFileSync(existing, "original");
			const { stageFfiRsNativeBindings } = await import("../src/utils/tools-manager.ts");

			stageFfiRsNativeBindings();

			expect(readFileSync(existing, "utf8")).toBe("original");
		});
	});

	it("is a no-op when the install left no ffi-rs directory to stage into", async () => {
		await withFreshManagedDir(async (managedDir) => {
			seedManagedTree(managedDir, { "ffi-rs-linux-x64-gnu": "ffi-rs.linux-x64-gnu.node" }, { withFfiRsDir: false });
			const { stageFfiRsNativeBindings } = await import("../src/utils/tools-manager.ts");

			expect(() => stageFfiRsNativeBindings()).not.toThrow();
			expect(existsSync(join(managedDir, "node_modules", "ffi-rs"))).toBe(false);
		});
	});

	it("is a no-op when no scoped bindings were installed at all", async () => {
		await withFreshManagedDir(async (managedDir) => {
			seedManagedTree(managedDir, {});
			const { stageFfiRsNativeBindings } = await import("../src/utils/tools-manager.ts");

			expect(() => stageFfiRsNativeBindings()).not.toThrow();
			expect(existsSync(join(managedDir, "node_modules", "@yuuang"))).toBe(false);
		});
	});

	it("resolves @ff-labs/fff-node via dist/index.cjs when bare require throws", async () => {
		await withFreshManagedDir(async (managedDir) => {
			const fffDir = join(managedDir, "node_modules", "@ff-labs", "fff-node");
			mkdirSync(join(fffDir, "dist"), { recursive: true });
			writeFileSync(
				join(fffDir, "package.json"),
				JSON.stringify({ name: "@ff-labs/fff-node", main: "dist/index.cjs" }),
			);
			writeFileSync(join(fffDir, "dist", "index.cjs"), "module.exports = { FileFinder: class {}, ok: true };");

			const { loadAvailableFffNodePackage } = await import("../src/utils/tools-manager.ts");
			const fakeRequire = ((id: string) => {
				if (id === "@ff-labs/fff-node") {
					throw new Error("Cannot find module '@ff-labs/fff-node'");
				}
				if (id.endsWith("index.cjs")) {
					return { FileFinder: class {}, ok: true };
				}
				throw new Error(`Unexpected require: ${id}`);
			}) as unknown as Parameters<typeof loadAvailableFffNodePackage>[0] extends readonly (infer R)[] | undefined
				? R
				: never;
			(fakeRequire as { resolve?: (id: string) => string }).resolve = (id: string) => {
				if (id === "@ff-labs/fff-node/package.json") {
					return join(fffDir, "package.json");
				}
				throw new Error(`Cannot resolve ${id}`);
			};

			const loaded = loadAvailableFffNodePackage([fakeRequire]);
			expect(loaded).toBeDefined();
			expect((loaded as { ok?: boolean } | undefined)?.ok).toBe(true);
		});
	});

	it("loads managed dist/index.cjs by absolute path when require.resolve is unavailable", async () => {
		await withFreshManagedDir(async (managedDir) => {
			const fffDir = join(managedDir, "node_modules", "@ff-labs", "fff-node");
			mkdirSync(join(fffDir, "dist"), { recursive: true });
			writeFileSync(
				join(fffDir, "package.json"),
				JSON.stringify({ name: "@ff-labs/fff-node", main: "dist/index.cjs" }),
			);
			writeFileSync(
				join(fffDir, "dist", "index.cjs"),
				"module.exports = { FileFinder: class {}, fromManagedDisk: true };",
			);

			const { getLastFffLoadError, loadAvailableFffNodePackage, loadFffNodeFromManagedInstall } = await import(
				"../src/utils/tools-manager.ts"
			);
			const loaded = loadFffNodeFromManagedInstall() as { fromManagedDisk?: boolean } | undefined;
			expect({
				fromManagedDisk: loaded?.fromManagedDisk,
				error: getLastFffLoadError(),
			}).toEqual({ fromManagedDisk: true, error: undefined });
			// Explicit requires, including empty, must not pick up the managed tree.
			expect(loadAvailableFffNodePackage([])).toBeUndefined();
		});
	});

	it("keeps a missing managed dist closed on the absolute-path loader", async () => {
		await withFreshManagedDir(async () => {
			const { loadFffNodeFromManagedInstall } = await import("../src/utils/tools-manager.ts");
			expect(loadFffNodeFromManagedInstall()).toBeUndefined();
		});
	});
});

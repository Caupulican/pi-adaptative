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
});

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeArtifactStore, type RuntimeOrigin } from "../src/cli/runtime-artifact-store.ts";

describe("RuntimeArtifactStore", () => {
	it.each([true, false])(
		"captures nested read-only runtime directories without changing the origin (pool=%s)",
		async (usePool) => {
			const temporary = mkdtempSync(join(tmpdir(), "pi-runtime-artifact-readonly-"));
			const root = join(temporary, "origin");
			const resources = join(root, "bundled-resources");
			const extensions = join(resources, "extensions");
			mkdirSync(extensions, { recursive: true });
			writeFileSync(join(extensions, "entry.mjs"), "export const marker = 'copied';\n");
			writeFileSync(join(root, "pi"), "standalone binary bytes\n");
			writeFileSync(join(root, "loader.mjs"), "export {};\n");
			writeFileSync(join(root, "cli.mjs"), "process.exit(0);\n");
			chmodSync(extensions, 0o555);
			chmodSync(resources, 0o555);
			chmodSync(root, 0o555);
			const sourceModes = [root, resources, extensions].map((path) => statSync(path).mode);

			const pool = usePool ? join(temporary, "pool") : undefined;
			const generations = join(temporary, "generations");
			mkdirSync(generations);
			const store = new RuntimeArtifactStore(
				{
					root,
					entries: ["bundled-resources", "pi", "loader.mjs", "cli.mjs"],
					target: {
						executable: join(root, "pi"),
						argsPrefix: ["--import", join(root, "loader.mjs"), join(root, "cli.mjs")],
					},
				} satisfies RuntimeOrigin,
				generations,
				pool,
			);
			let generation: string | undefined;
			try {
				generation = await store.capture();
				const copiedExtension = join(generation, "bundled-resources", "extensions", "entry.mjs");
				expect(readFileSync(copiedExtension, "utf8")).toBe("export const marker = 'copied';\n");
				const snapshotProbe = join(generation, "bundled-resources", "extensions", "snapshot-probe");
				writeFileSync(snapshotProbe, "staging directory is writable");
				expect(readFileSync(snapshotProbe, "utf8")).toBe("staging directory is writable");
				rmSync(snapshotProbe);
				expect(store.target(generation)).toEqual({
					executable: join(generation, "pi"),
					argsPrefix: ["--import", join(generation, "loader.mjs"), join(generation, "cli.mjs")],
				});
				expect([root, resources, extensions].map((path) => statSync(path).mode)).toEqual(sourceModes);
				if (process.platform !== "win32")
					expect(sourceModes.map((mode) => mode & 0o777)).toEqual([0o555, 0o555, 0o555]);

				const retiredGeneration = generation;
				await store.retire(retiredGeneration);
				generation = undefined;
				await store.settle();
				expect(existsSync(copiedExtension)).toBe(false);
				expect(() => store.target(retiredGeneration)).toThrow(/Runtime artifact is not owned by this supervisor/);
				expect(pool ? readdirPoolHasContent(pool) : false).toBe(usePool);
			} finally {
				try {
					if (generation) await store.retire(generation);
					await store.settle();
				} finally {
					chmodSync(root, 0o700);
					chmodSync(resources, 0o700);
					chmodSync(extensions, 0o700);
					rmSync(temporary, { recursive: true, force: true });
				}
			}
		},
	);
});

function readdirPoolHasContent(pool: string): boolean {
	return existsSync(pool) && walk(pool).some((path) => statSync(path).isFile());
}

function walk(directory: string): string[] {
	return readdirSync(directory).flatMap((entry) => {
		const path = join(directory, entry);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

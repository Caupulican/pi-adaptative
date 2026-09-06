import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectPythonInterpreter } from "../src/core/python-runtime.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function executableFixture() {
	const directory = await mkdtemp(join(tmpdir(), "pi-runtime-identity-"));
	directories.push(directory);
	const path = join(directory, "synthetic-runtime");
	await writeFile(path, "synthetic executable metadata fixture", { mode: 0o700 });
	return { directory, path };
}

describe("native interpreter filesystem identity", () => {
	it("changes identity when an executable is replaced and rejects a directory replacement", async () => {
		const { directory, path } = await executableFixture();
		const original = inspectPythonInterpreter(path);
		expect(original).toEqual(expect.any(String));
		expect(inspectPythonInterpreter(path)).toBe(original);
		await writeFile(path, "different sized replacement", { mode: 0o700 });
		expect(inspectPythonInterpreter(path)).not.toBe(original);
		await rename(path, join(directory, "retained-original"));
		expect(inspectPythonInterpreter(path)).toBeUndefined();
		await mkdir(path);
		expect(inspectPythonInterpreter(path)).toBeUndefined();
	});

	it("rejects relative paths and NUL without resolving them against ambient cwd", async () => {
		const { path } = await executableFixture();
		expect(inspectPythonInterpreter("./synthetic-runtime")).toBeUndefined();
		expect(inspectPythonInterpreter(`${path}\0`)).toBeUndefined();
	});

	it.skipIf(process.platform === "win32")(
		"requires POSIX execute permission and tracks symlink target identity",
		async () => {
			const { directory, path } = await executableFixture();
			const link = join(directory, "linked-runtime");
			await symlink(path, link);
			expect(inspectPythonInterpreter(link)).toBe(inspectPythonInterpreter(path));
			await chmod(path, 0o600);
			expect(inspectPythonInterpreter(path)).toBeUndefined();
			expect(inspectPythonInterpreter(link)).toBeUndefined();
		},
	);
});

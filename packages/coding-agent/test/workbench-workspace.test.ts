import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceObservation } from "../src/modes/interactive/workbench-workspace.ts";

describe("event-triggered workspace observations", () => {
	it("uses cwd-relative literal paths in nested worktrees", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-workbench-nested-"));
		const observer = new WorkspaceObservation();
		try {
			execFileSync("git", ["init", "--quiet", directory]);
			const nested = join(directory, "nested");
			await mkdir(nested);
			await writeFile(join(nested, "[code].txt"), "before\n");
			execFileSync("git", ["-C", directory, "add", "."]);
			await observer.begin(nested);
			await writeFile(join(nested, "[code].txt"), "after\n");
			const result = await observer.observe();
			expect(result?.paths).toEqual(["[code].txt"]);
			expect(result?.patch).toContain("+after");
		} finally {
			observer.dispose();
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("serializes overlapping boundaries without publishing the same change twice", async () => {
		let calls = 0;
		let active = 0;
		let peak = 0;
		const observer = new WorkspaceObservation({
			async snapshot() {
				peak = Math.max(peak, ++active);
				await Promise.resolve();
				active--;
				return { files: new Map([["code", ++calls === 1 ? "before" : "after"]]), limited: false };
			},
			patch: async () => "+after",
		});
		await observer.begin("/fixture");
		const results = await Promise.all([observer.observe(), observer.observe(), observer.observe()]);
		expect(peak).toBe(1);
		expect(results.map((result) => result?.paths)).toEqual([["code"], [], []]);
		observer.dispose();
	});
	it("discloses a raced baseline instead of silently treating edits during initialization as pre-existing", async () => {
		let release: ((snapshot: { files: Map<string, string>; limited: boolean }) => void) | undefined;
		let calls = 0;
		const snapshot = { files: new Map([["fast.py", "modified"]]), limited: false };
		const observer = new WorkspaceObservation({
			snapshot: () =>
				++calls === 1
					? new Promise((resolve) => {
							release = resolve;
						})
					: Promise.resolve(snapshot),
			patch: async () => "+change",
		});
		const pending = observer.begin("/fixture");
		observer.noteExecution();
		release?.(snapshot);
		await pending;
		const result = await observer.observe();
		expect(result?.paths).toEqual(["fast.py"]);
		expect(result?.note).toContain("overlapped");
		expect((await observer.observe())?.paths).toEqual([]);
		observer.dispose();
	});
	it("notices silent changes and new files but not pre-existing unchanged work", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-workbench-"));
		try {
			execFileSync("git", ["init", "--quiet", directory]);
			await writeFile(join(directory, "existing.txt"), "user work\n");
			await writeFile(join(directory, "code.txt"), "old\n");
			execFileSync("git", ["-C", directory, "add", "code.txt"]);
			const observer = new WorkspaceObservation();
			await observer.begin(directory);
			expect((await observer.observe())?.paths).toEqual([]);
			await writeFile(join(directory, "code.txt"), "new\n");
			await writeFile(join(directory, "created.txt"), "created silently\n");
			const result = await observer.observe();
			expect(result?.paths).toEqual(expect.arrayContaining(["code.txt", "created.txt"]));
			expect(result?.paths).not.toContain("existing.txt");
			expect(result?.patch).toContain("+new");
			expect((await observer.observe())?.paths).toEqual([]);
			observer.dispose();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("fences stale observation results after session replacement or disposal", async () => {
		let finish: ((value: { files: Map<string, string>; limited: boolean }) => void) | undefined;
		const observer = new WorkspaceObservation({
			snapshot: () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
			patch: async () => "",
		});
		const pending = observer.begin("/fixture");
		observer.dispose();
		finish?.({ files: new Map([["stale.txt", "changed"]]), limited: false });
		await pending;
		expect(await observer.observe()).toBeUndefined();
	});
});

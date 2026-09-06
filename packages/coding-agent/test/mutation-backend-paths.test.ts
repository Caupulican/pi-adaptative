import { posix, win32 } from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createEditTool, createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createFileFailureRecoveryAuthority } from "../src/core/tools/file-failure-recovery.ts";
import { FileMutationIntentController } from "../src/core/tools/file-mutation-intent.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createWriteTool } from "../src/core/tools/write.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { backendReadPaths } from "./fixtures/backend-read-paths.ts";
import { memoryFileBackend } from "./fixtures/memory-file-backend.ts";

describe("mutation backend path binding", () => {
	it("copies only controller-owned content references on the same backend", async () => {
		const backend = memoryFileBackend("win32");
		backend.mkdir("Q:\\fixture");
		const intentController = new FileMutationIntentController({
			operations: backend.operations,
			pathOptions: { flavor: "win32" },
		});
		const write = createWriteTool("Q:\\fixture", { operations: backend.write, intentController });
		await write.execute("fixture-original", { path: "original.txt", content: "synthetic bytes" });
		const reference = intentController.rememberContent("Q:\\fixture\\original.txt", "synthetic bytes");
		await write.execute("fixture-copy", { path: "copied.txt", contentRef: reference.contentRef });
		expect(backend.files.get("Q:\\fixture\\copied.txt")).toBe("synthetic bytes");
		const other = memoryFileBackend("win32");
		other.mkdir("Q:\\fixture");
		const otherController = new FileMutationIntentController({
			operations: other.operations,
			pathOptions: { flavor: "win32" },
		});
		const otherWrite = createWriteTool("Q:\\fixture", { operations: other.write, intentController: otherController });
		await expect(
			otherWrite.execute("fixture-foreign", { path: "copied.txt", contentRef: reference.contentRef }),
		).rejects.toThrow(/another session/i);
		expect(other.files.size).toBe(0);
	});

	it("preserves a backend collision and retargets the retained payload without overwriting", async () => {
		const backend = memoryFileBackend("win32");
		backend.seed("Q:\\fixture\\occupied.txt", "keep");
		const intentController = new FileMutationIntentController({
			operations: backend.operations,
			pathOptions: { flavor: "win32" },
		});
		const write = createWriteTool("Q:\\fixture", { operations: backend.write, intentController });
		let failure: unknown;
		try {
			await write.execute("fixture-collision", { path: "occupied.txt", content: "retained" });
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		const ref = /payloadRef (file-mutation:[\w-]+)/.exec(String(failure))?.[1];
		if (!ref) throw new Error("Expected backend-owned retained payload");
		await write.execute("fixture-retarget", { path: "new.txt", payloadRef: ref });
		expect([...backend.files]).toEqual([
			["Q:\\fixture\\occupied.txt", "keep"],
			["Q:\\fixture\\new.txt", "retained"],
		]);
		await intentController.dispose();
	});

	it("does not mutate when cancelled while waiting for a backend queue", async () => {
		const backend = memoryFileBackend("win32");
		backend.mkdir("Q:\\fixture");
		const intentController = new FileMutationIntentController({
			operations: backend.operations,
			pathOptions: { flavor: "win32" },
		});
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const held = intentController.withMutationQueue("Q:\\fixture\\cancelled.txt", async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		const abort = new AbortController();
		const write = createWriteTool("Q:\\fixture", { operations: backend.write, intentController });
		const rejected = expect(
			write.execute("fixture-cancel", { path: "cancelled.txt", content: "never" }, abort.signal),
		).rejects.toThrow(/aborted/i);
		try {
			await setImmediate();
			abort.abort();
		} finally {
			release.resolve();
			await held;
		}
		await rejected;
		expect(backend.files.size).toBe(0);
	});

	it("rejects foreign mutation paths without matching operations before local I/O", () => {
		const flavor = process.platform === "win32" ? "posix" : "win32";
		expect(() => new FileMutationIntentController({ pathOptions: { flavor } })).toThrow(/custom operations/i);
		const backend = memoryFileBackend(flavor);
		const intentController = new FileMutationIntentController({
			operations: backend.operations,
			pathOptions: { flavor },
		});
		expect(() => createWriteTool("/fixture", { intentController })).toThrow(/custom operations/i);
		expect(() => createEditTool("/fixture", { intentController })).toThrow(/custom operations/i);
		expect(backend.probes).toEqual([]);
	});

	it.each(["R:relative.txt", "~/missing-home.txt"])(
		"rejects unresolved backend input before mutation: %s",
		async (path) => {
			const backend = memoryFileBackend("win32");
			const intentController = new FileMutationIntentController({
				operations: backend.operations,
				pathOptions: { flavor: "win32" },
			});
			const write = createWriteTool("Q:\\fixture", { operations: backend.write, intentController });
			await expect(write.execute("fixture-invalid", { path, content: "never" })).rejects.toThrow(
				/drive-relative|home/i,
			);
			expect(backend.probes).toEqual([]);
			expect(backend.files.size).toBe(0);
		},
	);
	it("previews through the executing backend, not the renderer's operator directory", async () => {
		initTheme("dark");
		const backend = memoryFileBackend("win32");
		backend.seed("Q:\\fixture\\file.txt", "before");
		const intentController = new FileMutationIntentController({
			operations: backend.operations,
			pathOptions: { flavor: "win32" },
		});
		const definition = createEditToolDefinition("Q:\\fixture", { operations: backend.edit, intentController });
		const invalidated = Promise.withResolvers<void>();
		const args = { path: "file.txt", edits: [{ oldText: "before", newText: "after" }] };
		const component = definition.renderCall?.(args, theme, {
			args,
			toolCallId: "fixture-preview",
			invalidate: () => invalidated.resolve(),
			lastComponent: undefined,
			state: {},
			cwd: "/fixture/operator",
			executionStarted: false,
			argsComplete: true,
			isPartial: false,
			expanded: true,
			showImages: false,
			isError: false,
		});
		await invalidated.promise;
		const refreshed = definition.renderCall?.(args, theme, {
			args,
			toolCallId: "fixture-preview",
			invalidate: () => {},
			lastComponent: component,
			state: {},
			cwd: "/fixture/operator",
			executionStarted: false,
			argsComplete: true,
			isPartial: false,
			expanded: true,
			showImages: false,
			isError: false,
		});
		expect(refreshed?.render(120).join("\n")).toContain("after");
		expect([...backend.files]).toEqual([["Q:\\fixture\\file.txt", "before"]]);
	});
	it.each(backendReadPaths)("creates, edits, and reads the same $flavor backend resource: $input", async (fixture) => {
		const backend = memoryFileBackend(fixture.flavor);
		const pathOptions = { flavor: fixture.flavor, ...("homeDir" in fixture ? { homeDir: fixture.homeDir } : {}) };
		backend.mkdir((fixture.flavor === "win32" ? win32 : posix).dirname(fixture.expected));
		const intentController = new FileMutationIntentController({ operations: backend.operations, pathOptions });
		const write = createWriteTool(fixture.cwd, { operations: backend.write, intentController });
		const edit = createEditTool(fixture.cwd, { operations: backend.edit, intentController });
		const read = createReadTool(fixture.cwd, { operations: backend.read, pathOptions });
		await write.execute("fixture-write", { path: fixture.input, content: "before" });
		expect([...backend.files]).toEqual([[fixture.expected, "before"]]);
		await edit.execute("fixture-edit", { path: fixture.input, edits: [{ oldText: "before", newText: "after" }] });
		expect([...backend.files]).toEqual([[fixture.expected, "after"]]);
		await expect(read.execute("fixture-read", { path: fixture.input })).resolves.toMatchObject({
			content: [{ text: "after" }],
		});
	});

	it("keeps preflight, queue, and recovery on the same exact Windows resource", async () => {
		const backend = memoryFileBackend("win32");
		const path = "Q:\\fixture\\file\u00a0name.txt";
		backend.seed(path, "before");
		const intentController = new FileMutationIntentController({
			operations: backend.operations,
			pathOptions: { flavor: "win32" },
		});
		const authority = createFileFailureRecoveryAuthority((value) => value);
		const edit = createEditTool("Q:\\fixture", {
			operations: backend.edit,
			intentController,
			failureRecoveryAuthority: authority,
		});
		const params = { path: "file\u00a0name.txt", edits: [{ oldText: "missing", newText: "after" }] };
		expect(
			edit.failureRecovery?.getFailureTargets?.(params, { failureCode: "edit_old_text_not_found" })?.[0].scope,
		).toBe(path);
		await expect(edit.execute("fixture-edit", params)).rejects.toThrow(/Could not find/);
		expect(backend.files.get(path)).toBe("before");
		expect(backend.probes.every((probe) => probe === path)).toBe(true);
	});
});

import { describe, expect, it, vi } from "vitest";
import { createFileFailureRecoveryAuthority } from "../src/core/tools/file-failure-recovery.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { backendReadPaths } from "./fixtures/backend-read-paths.ts";

function missing(path: string): Error {
	return Object.assign(new Error(`Synthetic missing file: ${path}`), { code: "ENOENT" });
}

describe("read backend resource identity", () => {
	it.each(backendReadPaths)("uses only the declared $flavor backend for $input", async (fixture) => {
		const operations = {
			expected: fixture.expected,
			async access(path: string) {
				// Method receiver must survive passing this operation through the resolver.
				if (path !== this.expected) throw missing(path);
			},
			readFile: vi.fn(async () => Buffer.from("synthetic backend content")),
		};
		const access = vi.spyOn(operations, "access");
		const tool = createReadTool(fixture.cwd, {
			operations,
			pathOptions: {
				flavor: fixture.flavor,
				...("homeDir" in fixture ? { homeDir: fixture.homeDir } : {}),
			},
		});
		await expect(tool.execute("fixture-call", { path: fixture.input })).resolves.toMatchObject({
			content: [{ text: "synthetic backend content" }],
		});
		expect(access).toHaveBeenCalledExactlyOnceWith(fixture.expected);
		expect(operations.readFile).toHaveBeenCalledExactlyOnceWith(fixture.expected);
	});

	it("prefers the exact spelling when both the exact and normalized files exist", async () => {
		const access = vi.fn(async () => {});
		const readFile = vi.fn(async (path: string) => Buffer.from(path));
		const tool = createReadTool("/fixture/work", {
			pathOptions: { flavor: "posix" },
			operations: { access, readFile },
		});
		await expect(tool.execute("fixture-call", { path: "file\u00a0name.txt" })).resolves.toMatchObject({
			content: [{ text: "/fixture/work/file\u00a0name.txt" }],
		});
		expect(access).toHaveBeenCalledOnce();
	});

	it.each(["ENOENT", "ENOTDIR"])("uses a spelling fallback only after %s and keeps probes unique", async (code) => {
		const expected = "/fixture/work/file name.txt";
		const access = vi.fn(async (path: string) => {
			if (path !== expected) throw Object.assign(missing(path), { code });
		});
		const tool = createReadTool("/fixture/work", {
			pathOptions: { flavor: "posix" },
			operations: {
				access,
				readFile: async () => Buffer.from("normalized spelling"),
			},
		});
		await expect(tool.execute("fixture-call", { path: "file\u00a0name.txt" })).resolves.toMatchObject({
			content: [{ text: "normalized spelling" }],
		});
		expect(access.mock.calls.map(([path]) => path)).toEqual(["/fixture/work/file\u00a0name.txt", expected]);
	});

	it("preserves the first missing-resource diagnostic after bounded alternate probes", async () => {
		const first = missing("synthetic original");
		const access = vi.fn(async () => {
			throw first;
		});
		const tool = createReadTool("/fixture/work", {
			pathOptions: { flavor: "posix" },
			operations: { access, readFile: vi.fn() },
		});
		await expect(tool.execute("fixture-call", { path: "é's\u00a0file.txt" })).rejects.toBe(first);
		const paths = access.mock.calls;
		expect(paths.length).toBeGreaterThan(1);
		expect(paths.length).toBeLessThanOrEqual(10);
		expect(new Set(paths.map((args) => String(args))).size).toBe(paths.length);
	});

	it.each(["before", "during"])("cancels %s lookup without another probe or a read", async (stage) => {
		const abort = new AbortController();
		if (stage === "before") abort.abort();
		const access = vi.fn(async () => {
			abort.abort();
			throw missing("synthetic");
		});
		const readFile = vi.fn();
		const tool = createReadTool("/fixture/work", {
			pathOptions: { flavor: "posix" },
			operations: { access, readFile },
		});
		await expect(tool.execute("fixture-call", { path: "é's.txt" }, abort.signal)).rejects.toThrow(/aborted/i);
		expect(access).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
		expect(readFile).not.toHaveBeenCalled();
	});

	it.each(["R:relative.txt", "~/missing-home.txt"])(
		"rejects unresolved Windows context before backend I/O: %s",
		async (path) => {
			const access = vi.fn();
			const readFile = vi.fn();
			const tool = createReadTool("Q:\\fixture", {
				pathOptions: { flavor: "win32" },
				operations: { access, readFile },
			});
			await expect(tool.execute("fixture-call", { path })).rejects.toThrow(/drive-relative|home/i);
			expect(access).not.toHaveBeenCalled();
			expect(readFile).not.toHaveBeenCalled();
		},
	);

	it("rejects foreign path semantics without a foreign backend", () => {
		const flavor = process.platform === "win32" ? "posix" : "win32";
		expect(() => createReadTool("/fixture", { pathOptions: { flavor } })).toThrow(/custom operations/i);
	});
	it("does not evaluate a failing convenience expansion when the literal name exists", async () => {
		const access = vi.fn(async () => {});
		const tool = createReadTool("/fixture/backend", {
			pathOptions: { flavor: "posix" },
			operations: {
				access,
				readFile: async () => Buffer.from("literal"),
			},
		});
		await expect(tool.execute("fixture-call", { path: "@~/note.txt" })).resolves.toMatchObject({
			content: [{ text: "literal" }],
		});
		expect(access).toHaveBeenCalledExactlyOnceWith("/fixture/backend/@~/note.txt");
	});

	it.each([
		{
			flavor: "posix" as const,
			cwd: "/fixture/work\u00a0space",
			input: "missing\u00a0file.txt",
			expected: "/fixture/work\u00a0space/missing\u00a0file.txt",
		},
		{
			flavor: "win32" as const,
			cwd: "Q:\\fixture\\work",
			input: "missing.txt",
			expected: "Q:\\fixture\\work\\missing.txt",
		},
	])("binds missing-read recovery to the exact $flavor backend identity", ({ flavor, cwd, input, expected }) => {
		const authority = createFileFailureRecoveryAuthority((path) => path);
		const tool = createReadTool(cwd, {
			pathOptions: { flavor },
			failureRecoveryAuthority: authority,
			operations: { access: async () => {}, readFile: async () => Buffer.from("") },
		});
		expect(tool.failureRecovery?.getFailureTargets?.({ path: input }, { failureCode: "file_not_found" })).toEqual([
			{ authority: authority.contractAuthority, kind: "filesystem.file.exists", scope: expected },
		]);
	});
	it.each(["file\u00a0name.txt", "file\u202fname.txt", "Capture d’écran.txt", "é.txt"])(
		"reads exact backend names without probing the operator filesystem: %s",
		async (name) => {
			const cwd = "/fixture/work\u00a0space";
			const expected = `${cwd}/${name}`;
			const readFile = vi.fn(async (path: string) => {
				if (path !== expected) throw missing(path);
				return Buffer.from("exact backend content");
			});
			const tool = createReadTool(cwd, {
				pathOptions: { flavor: "posix" },
				operations: {
					access: async (path) => {
						if (path !== expected) throw missing(path);
					},
					readFile,
				},
			});
			await expect(tool.execute("fixture-call", { path: name })).resolves.toMatchObject({
				content: [{ type: "text", text: "exact backend content" }],
			});
			expect(readFile).toHaveBeenCalledExactlyOnceWith(expected);
		},
	);

	it("resolves a backend-only screenshot spelling through that backend's access port", async () => {
		const cwd = "/fixture/backend";
		const expected = `${cwd}/Capture d’écran.txt`;
		const probed: string[] = [];
		const tool = createReadTool(cwd, {
			pathOptions: { flavor: "posix" },
			operations: {
				access: async (path) => {
					probed.push(path);
					if (path !== expected) throw missing(path);
				},
				readFile: async (path) => {
					if (path !== expected) throw missing(path);
					return Buffer.from("backend variant");
				},
			},
		});
		await expect(tool.execute("fixture-call", { path: "Capture d'écran.txt" })).resolves.toMatchObject({
			content: [{ type: "text", text: "backend variant" }],
		});
		expect(probed).toContain(expected);
	});

	it.each(["EACCES", "EIO", "ELOOP"])("preserves %s without trying another spelling", async (code) => {
		const error = Object.assign(new Error("synthetic access failed"), { code });
		const access = vi.fn(async () => {
			throw error;
		});
		const readFile = vi.fn();
		const tool = createReadTool("/fixture/backend", {
			pathOptions: { flavor: "posix" },
			operations: { access, readFile },
		});
		await expect(tool.execute("fixture-call", { path: "Capture d'écran.txt" })).rejects.toBe(error);
		expect(access).toHaveBeenCalledOnce();
		expect(readFile).not.toHaveBeenCalled();
	});
});

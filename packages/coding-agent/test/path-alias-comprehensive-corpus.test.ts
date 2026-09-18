import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	buildPathAliasTable,
	expandText,
	extractPathCandidates,
	type PathAliasTable,
} from "../src/core/context/path-alias-table.ts";
import { wrapToolWithPathAliasExpansion } from "../src/core/context/path-alias-tool-wrap.ts";

describe("50-case path and parameter comprehensive corpus", () => {
	const repo = "/repo";
	const grepPath = "packages/coding-agent/src/core/tools/grep.ts";
	const tableWithGrep: PathAliasTable = {
		cwd: repo,
		entries: [{ id: "p/grep.ts", path: grepPath }],
	};

	function createMockTool(paramKey: string) {
		const calls: unknown[] = [];
		const tool = {
			name: `tool_with_${paramKey}`,
			label: "Mock Tool",
			description: "Mock execution tool",
			parameters: Type.Object({ [paramKey]: Type.Optional(Type.Any()) }),
			async execute(_id: string, params: unknown) {
				calls.push(params);
				return { content: [{ type: "text" as const, text: "ok" }], details: undefined };
			},
		};
		const wrapped = wrapToolWithPathAliasExpansion(
			tool as never,
			() => tableWithGrep,
			new WeakSet(),
			() => repo,
		);
		return { tool, wrapped, calls };
	}

	// --------------------------------------------------------------------------
	// Section 1: Windows Absolute, Drive, and UNC Paths (Cases 1-8)
	// --------------------------------------------------------------------------
	it("Case 1: Windows forward-slash drive path expands as absolute without cwd prepended", () => {
		const table: PathAliasTable = {
			cwd: repo,
			entries: [{ id: "p/index.ts", path: "C:/repo/src/index.ts" }],
		};
		expect(expandText(table, "open p/index.ts now", true)).toBe("open C:/repo/src/index.ts now");
	});

	it("Case 2: Windows backslash drive path expands as absolute without cwd prepended", () => {
		const table: PathAliasTable = {
			cwd: repo,
			entries: [{ id: "p/index.ts", path: String.raw`C:\repo\src\index.ts` }],
		};
		expect(expandText(table, "open p/index.ts now", true)).toBe(String.raw`open C:\repo\src\index.ts now`);
	});

	it("Case 3: Windows mixed-slash drive path expands as absolute without cwd prepended", () => {
		const table: PathAliasTable = {
			cwd: repo,
			entries: [{ id: "p/file.ts", path: String.raw`C:/repo\sub/file.ts` }],
		};
		expect(expandText(table, "open p/file.ts now", true)).toBe(String.raw`open C:/repo\sub/file.ts now`);
	});

	it("Case 4: Windows lowercase drive letter expands as absolute without cwd prepended", () => {
		const table: PathAliasTable = {
			cwd: repo,
			entries: [{ id: "p/data.txt", path: String.raw`c:\users\data.txt` }],
		};
		expect(expandText(table, "open p/data.txt now", true)).toBe(String.raw`open c:\users\data.txt now`);
	});

	it("Case 5: Windows path with spaces and parentheses expands as absolute without cwd prepended", () => {
		const table: PathAliasTable = {
			cwd: repo,
			entries: [{ id: "p/bin.exe", path: String.raw`C:\Program Files (x86)\App\bin.exe` }],
		};
		expect(expandText(table, "run p/bin.exe now", true)).toBe(String.raw`run C:\Program Files (x86)\App\bin.exe now`);
	});

	it("Case 6: Windows drive root path expands as absolute without cwd prepended", () => {
		const table: PathAliasTable = {
			cwd: repo,
			entries: [{ id: "p/root", path: "C:\\" }],
		};
		expect(expandText(table, "at p/root", true)).toBe("at C:\\");
	});

	it("Case 7: Windows UNC network path with backslashes expands as absolute without cwd prepended", () => {
		const table: PathAliasTable = {
			cwd: repo,
			entries: [{ id: "p/file.ts", path: String.raw`\\server\share\sub\file.ts` }],
		};
		expect(expandText(table, "open p/file.ts now", true)).toBe(String.raw`open \\server\share\sub\file.ts now`);
	});

	it("Case 8: Windows UNC network path with forward slashes expands as absolute without cwd prepended", () => {
		const table: PathAliasTable = {
			cwd: repo,
			entries: [{ id: "p/file.ts", path: "//server/share/sub/file.ts" }],
		};
		expect(expandText(table, "open p/file.ts now", true)).toBe("open //server/share/sub/file.ts now");
	});

	// --------------------------------------------------------------------------
	// Section 2: POSIX Absolute, Dot-Relative, and Relative Paths (Cases 9-14)
	// --------------------------------------------------------------------------
	it("Case 9: POSIX standard absolute path expands as absolute", () => {
		const table: PathAliasTable = {
			cwd: repo,
			entries: [{ id: "p/app", path: "/usr/local/bin/app" }],
		};
		expect(expandText(table, "exec p/app now", true)).toBe("exec /usr/local/bin/app now");
	});

	it("Case 10: POSIX deep repository path expands as absolute", () => {
		const table: PathAliasTable = {
			cwd: repo,
			entries: [{ id: "p/index.ts", path: "/home/user/repo/src/index.ts" }],
		};
		expect(expandText(table, "view p/index.ts now", true)).toBe("view /home/user/repo/src/index.ts now");
	});

	it("Case 11: POSIX root path expands as absolute", () => {
		const table: PathAliasTable = {
			cwd: repo,
			entries: [{ id: "p/root", path: "/" }],
		};
		expect(expandText(table, "ls p/root now", true)).toBe("ls / now");
	});

	it("Case 12: POSIX dot-relative path resolves against cwd when absolute=true", () => {
		const table: PathAliasTable = {
			cwd: repo,
			entries: [{ id: "p/index.ts", path: "./src/index.ts" }],
		};
		expect(expandText(table, "open p/index.ts now", true)).toBe("open /repo/src/index.ts now");
	});

	it("Case 13: Clean relative path without prefix resolves against cwd when absolute=true", () => {
		const table: PathAliasTable = {
			cwd: repo,
			entries: [{ id: "p/index.ts", path: "src/index.ts" }],
		};
		expect(expandText(table, "open p/index.ts now", true)).toBe("open /repo/src/index.ts now");
	});

	it("Case 14: Windows dot-relative path resolves against cwd when absolute=true", () => {
		const table: PathAliasTable = {
			cwd: repo,
			entries: [{ id: "p/index.ts", path: String.raw`.\src\index.ts` }],
		};
		expect(expandText(table, "open p/index.ts now", true)).toBe("open /repo/src/index.ts now");
	});

	// --------------------------------------------------------------------------
	// Section 3: Ephemeral Tool Stream Log Rejection (Cases 15-20)
	// --------------------------------------------------------------------------
	it("Case 15: Ephemeral tool-streams pi-bash log is excluded from path aliasing", () => {
		const table = buildPathAliasTable(repo, ["Log in /tmp/tool-streams/pi-bash-1234abcd.log"]);
		expect(table.entries).toHaveLength(0);
	});

	it("Case 16: Ephemeral tool-streams pi-python-stdout log is excluded from path aliasing", () => {
		const table = buildPathAliasTable(repo, ["Log in /var/log/tool-streams/pi-python-stdout-12345678.log"]);
		expect(table.entries).toHaveLength(0);
	});

	it("Case 17: Ephemeral tool-streams pi-python-stderr log with Windows path is excluded", () => {
		const table = buildPathAliasTable(repo, [
			String.raw`Windows log: C:\Temp\tool-streams\pi-python-stderr-abcdef01.log`,
		]);
		expect(table.entries).toHaveLength(0);
	});

	it("Case 18: Ephemeral tool-streams pi-output log is excluded from path aliasing", () => {
		const table = buildPathAliasTable(repo, ["Log in /tmp/tool-streams/pi-output-12345678.log"]);
		expect(table.entries).toHaveLength(0);
	});

	it("Case 19: Bare ephemeral stream log without directory prefix is excluded", () => {
		const table = buildPathAliasTable(repo, [
			"Bare logs: ./pi-bash-12345678.log and ./pi-python-stdout-abcdef01.log and ./pi-output-98765432.log",
		]);
		expect(table.entries).toHaveLength(0);
	});

	it("Case 20: Ephemeral log in custom directory outside tool-streams is excluded", () => {
		const table = buildPathAliasTable(repo, [
			"Custom logs in /var/custom/pi-bash-1234abcd.log and D:\\custom\\pi-output-deadbeef.log",
		]);
		expect(table.entries).toHaveLength(0);
	});

	// --------------------------------------------------------------------------
	// Section 4: Non-Ephemeral Logs & Non-File Candidates (Cases 21-29)
	// --------------------------------------------------------------------------
	it("Case 21: Legitimate application log files are not misclassified as ephemeral", () => {
		const text = "Server logs in /var/log/production/application.log";
		const candidates = extractPathCandidates(text);
		expect(candidates).toContain("/var/log/production/application.log");
	});

	it("Case 22: Custom non-ephemeral service logs are not misclassified as ephemeral", () => {
		const text = "Worker logs in /var/log/services/pi-custom-service.log";
		const candidates = extractPathCandidates(text);
		expect(candidates).toContain("/var/log/services/pi-custom-service.log");
	});

	it("Case 23: Git refs are never aliased as filesystem paths", () => {
		const text = "Branch at origin/main and refs/heads/feature-1";
		const candidates = extractPathCandidates(text);
		expect(candidates).toEqual([]);
	});

	it("Case 24: Git revision ranges are never aliased as filesystem paths", () => {
		const text = "Compare v1.0.0...v1.1.0 in commit log";
		const candidates = extractPathCandidates(text);
		expect(candidates).toEqual([]);
	});

	it("Case 25: Numeric directories are never aliased as filesystem paths", () => {
		const text = "Archive created in 2026/01/15 and 20260903-125251";
		const candidates = extractPathCandidates(text);
		expect(candidates).toEqual([]);
	});

	it("Case 26: Bare file extensions are never aliased as filesystem paths", () => {
		const text = "Supported formats are .ts, .cpp, and .json";
		const candidates = extractPathCandidates(text);
		expect(candidates).toEqual([]);
	});

	it("Case 27: HTTP and Git URLs are never aliased as filesystem paths", () => {
		const text = "Clone https://github.com/repo/file.ts or git@github.com:repo/name.git";
		const candidates = extractPathCandidates(text);
		expect(candidates).toEqual([]);
	});

	it("Case 28: Percentile metrics like p50 and p90 are never expanded as path aliases", () => {
		const text = "Latency at p50 is 10ms, p90 is 50ms, and P99 is 120ms";
		expect(expandText(tableWithGrep, text)).toBe(text);
	});

	it("Case 29: Python math division expressions with p/ are never refused as unminted aliases", async () => {
		const { wrapped } = createMockTool("code");
		await expect(
			wrapped.execute(
				"call-code",
				{ code: "from pathlib import Path\np = Path('x')\nf = p / name\nratio = p/total" },
				undefined as never,
				undefined,
			),
		).resolves.toBeDefined();
	});

	// --------------------------------------------------------------------------
	// Section 5: Unminted vs Minted Aliases across all Parameter Keys & Shapes (Cases 30-50)
	// --------------------------------------------------------------------------
	it("Case 30: Minted path alias in 'path' parameter expands to canonical path", async () => {
		const { wrapped, calls } = createMockTool("path");
		await wrapped.execute("call-30", { path: "p/grep.ts" }, undefined as never, undefined);
		expect(calls).toEqual([{ path: `/repo/${grepPath}` }]);
	});

	it("Case 31: Unminted path alias in 'path' parameter is rejected with descriptive error", () => {
		const { wrapped } = createMockTool("path");
		expect(() => wrapped.execute("call-31", { path: "p/unminted.ts" }, undefined as never, undefined)).toThrow(
			/Unminted path alias "p\/unminted.ts"/,
		);
	});

	it("Case 32: Minted path aliases in 'paths' array parameter expand to canonical paths", async () => {
		const { wrapped, calls } = createMockTool("paths");
		await wrapped.execute("call-32", { paths: ["p/grep.ts"] }, undefined as never, undefined);
		expect(calls).toEqual([{ paths: [`/repo/${grepPath}`] }]);
	});

	it("Case 33: Unminted path aliases in 'paths' array parameter are rejected", () => {
		const { wrapped } = createMockTool("paths");
		expect(() => wrapped.execute("call-33", { paths: ["p/unminted.ts"] }, undefined as never, undefined)).toThrow(
			/Unminted path alias "p\/unminted.ts"/,
		);
	});

	it("Case 34: Unminted path alias in camelCase 'filePath' parameter is rejected", () => {
		const { wrapped } = createMockTool("filePath");
		expect(() => wrapped.execute("call-34", { filePath: "p/ghost.ts" }, undefined as never, undefined)).toThrow(
			/Unminted path alias "p\/ghost.ts"/,
		);
	});

	it("Case 35: Unminted path alias in snake_case 'file_path' parameter is rejected", () => {
		const { wrapped } = createMockTool("file_path");
		expect(() => wrapped.execute("call-35", { file_path: "p/ghost.ts" }, undefined as never, undefined)).toThrow(
			/Unminted path alias "p\/ghost.ts"/,
		);
	});

	it("Case 36: Unminted path alias in camelCase 'scriptPath' parameter is rejected", () => {
		const { wrapped } = createMockTool("scriptPath");
		expect(() => wrapped.execute("call-36", { scriptPath: "p/ghost.py" }, undefined as never, undefined)).toThrow(
			/Unminted path alias "p\/ghost.py"/,
		);
	});

	it("Case 37: Unminted path alias in snake_case 'script_path' parameter is rejected", () => {
		const { wrapped } = createMockTool("script_path");
		expect(() => wrapped.execute("call-37", { script_path: "p/ghost.py" }, undefined as never, undefined)).toThrow(
			/Unminted path alias "p\/ghost.py"/,
		);
	});

	it("Case 38: Unminted path alias in camelCase 'targetPath' parameter is rejected", () => {
		const { wrapped } = createMockTool("targetPath");
		expect(() => wrapped.execute("call-38", { targetPath: "p/ghost.ts" }, undefined as never, undefined)).toThrow(
			/Unminted path alias "p\/ghost.ts"/,
		);
	});

	it("Case 39: Unminted path alias in snake_case 'target_path' parameter is rejected", () => {
		const { wrapped } = createMockTool("target_path");
		expect(() => wrapped.execute("call-39", { target_path: "p/ghost.ts" }, undefined as never, undefined)).toThrow(
			/Unminted path alias "p\/ghost.ts"/,
		);
	});

	it("Case 40: Unminted path alias in camelCase 'sourcePath' parameter is rejected", () => {
		const { wrapped } = createMockTool("sourcePath");
		expect(() => wrapped.execute("call-40", { sourcePath: "p/ghost.ts" }, undefined as never, undefined)).toThrow(
			/Unminted path alias "p\/ghost.ts"/,
		);
	});

	it("Case 41: Unminted path alias in snake_case 'source_path' parameter is rejected", () => {
		const { wrapped } = createMockTool("source_path");
		expect(() => wrapped.execute("call-41", { source_path: "p/ghost.ts" }, undefined as never, undefined)).toThrow(
			/Unminted path alias "p\/ghost.ts"/,
		);
	});

	it("Case 42: Unminted path alias in camelCase 'destPath' parameter is rejected", () => {
		const { wrapped } = createMockTool("destPath");
		expect(() => wrapped.execute("call-42", { destPath: "p/ghost.ts" }, undefined as never, undefined)).toThrow(
			/Unminted path alias "p\/ghost.ts"/,
		);
	});

	it("Case 43: Unminted path alias in snake_case 'dest_path' parameter is rejected", () => {
		const { wrapped } = createMockTool("dest_path");
		expect(() => wrapped.execute("call-43", { dest_path: "p/ghost.ts" }, undefined as never, undefined)).toThrow(
			/Unminted path alias "p\/ghost.ts"/,
		);
	});

	it("Case 44: Unminted path alias in camelCase 'basePath' parameter is rejected", () => {
		const { wrapped } = createMockTool("basePath");
		expect(() => wrapped.execute("call-44", { basePath: "p/ghost.ts" }, undefined as never, undefined)).toThrow(
			/Unminted path alias "p\/ghost.ts"/,
		);
	});

	it("Case 45: Unminted path alias in snake_case 'base_path' parameter is rejected", () => {
		const { wrapped } = createMockTool("base_path");
		expect(() => wrapped.execute("call-45", { base_path: "p/ghost.ts" }, undefined as never, undefined)).toThrow(
			/Unminted path alias "p\/ghost.ts"/,
		);
	});

	it("Case 46: Unminted path alias in camelCase 'relativePath' parameter is rejected", () => {
		const { wrapped } = createMockTool("relativePath");
		expect(() => wrapped.execute("call-46", { relativePath: "p/ghost.ts" }, undefined as never, undefined)).toThrow(
			/Unminted path alias "p\/ghost.ts"/,
		);
	});

	it("Case 47: Unminted path alias in snake_case 'relative_path' parameter is rejected", () => {
		const { wrapped } = createMockTool("relative_path");
		expect(() => wrapped.execute("call-47", { relative_path: "p/ghost.ts" }, undefined as never, undefined)).toThrow(
			/Unminted path alias "p\/ghost.ts"/,
		);
	});

	it("Case 48: Unminted path alias in camelCase 'oldPath' / 'newPath' parameters is rejected", () => {
		const { wrapped } = createMockTool("oldPath");
		expect(() =>
			wrapped.execute("call-48", { oldPath: "p/ghost.ts", newPath: "p/ghost2.ts" }, undefined as never, undefined),
		).toThrow(/Unminted path alias "p\/ghost.ts"/);
	});

	it("Case 49: Unminted path alias in snake_case 'old_path' / 'new_path' parameters is rejected", () => {
		const { wrapped } = createMockTool("old_path");
		expect(() =>
			wrapped.execute("call-49", { old_path: "p/ghost.ts", new_path: "p/ghost2.ts" }, undefined as never, undefined),
		).toThrow(/Unminted path alias "p\/ghost.ts"/);
	});

	it("Case 50: Unminted path alias inside a deeply nested object is rejected", () => {
		const { wrapped } = createMockTool("nested");
		expect(() =>
			wrapped.execute(
				"call-50",
				{ nested: { subConfig: { target_path: "p/nested-ghost.ts" } } },
				undefined as never,
				undefined,
			),
		).toThrow(/Unminted path alias "p\/nested-ghost.ts"/);
	});
});

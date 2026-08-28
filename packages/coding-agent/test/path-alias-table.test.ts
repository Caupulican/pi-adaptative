import { homedir } from "node:os";
import { resolve as pathResolve } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import { describe, expect, it } from "vitest";
import {
	applyPathAliases,
	buildPathAliasTable,
	emptyPathAliasTable,
	expandParams,
	expandText,
	extendPathAliasTable,
	extractPathCandidates,
	type PathAliasTable,
	rewriteText,
} from "../src/core/context/path-alias-table.ts";

describe("path alias table", () => {
	it("aliases a long Windows screenshot path to p/basename and expands it back", () => {
		const windows = String.raw`C:\Users\Caupulican\Downloads\Screenshot_2.jpg`;
		const table = buildPathAliasTable("/repo", [`read ${windows}`]);
		expect(table.entries).toEqual([
			{ id: "p/Screenshot_2.jpg", path: "C:/Users/Caupulican/Downloads/Screenshot_2.jpg" },
		]);
		expect(rewriteText(table, `read ${windows}`)).toBe("read p/Screenshot_2.jpg");
		expect(expandText(table, "read p/Screenshot_2.jpg")).toBe("read C:/Users/Caupulican/Downloads/Screenshot_2.jpg");
	});

	it("uses unique basenames and grows the suffix when two files share a name", () => {
		const table = buildPathAliasTable("/repo", [
			"packages/coding-agent/src/core/tools/grep.ts:125",
			"packages/coding-agent/src/core/tools/grep.tsx",
			"packages/coding-agent/src/foo.ts",
			"packages/coding-agent/test/foo.ts",
			"ls.ts exists",
		]);
		expect(table.entries.map((entry) => entry.id).sort()).toEqual(
			["p/grep.ts", "p/grep.tsx", "p/src/foo.ts", "p/test/foo.ts"].sort(),
		);
		expect(rewriteText(table, "packages/coding-agent/src/core/tools/grep.ts:125")).toBe("p/grep.ts:125");
		expect(rewriteText(table, "ls.ts exists")).toBe("ls.ts exists");
	});

	it("does not alias URLs or already-assigned tokens", () => {
		expect(extractPathCandidates("see https://github.com/org/repo/blob/main/a.ts")).toEqual([]);
		const table = buildPathAliasTable("/repo", ["p/grep.ts is not a path"]);
		expect(table.entries).toEqual([]);
	});

	it("does not expand percentile metrics p50 p90 P50 P90", () => {
		const table = buildPathAliasTable("/repo", ["packages/coding-agent/src/core/tools/grep.ts"]);
		const metrics = "p50=1.2s p90=3.0s P50=100 P90=50 median=p50";
		expect(expandText(table, metrics)).toBe(metrics);
		expect(rewriteText(table, metrics)).toBe(metrics);
	});

	it("expands nested tool params and leaves unknown p/ tokens unchanged", () => {
		const table = buildPathAliasTable("/repo", ["packages/coding-agent/src/core/tools/grep.ts"]);
		expect(expandParams(table, { path: "p/grep.ts", nested: ["p/grep.ts", "p/missing.ts"] })).toEqual({
			path: "packages/coding-agent/src/core/tools/grep.ts",
			nested: ["packages/coding-agent/src/core/tools/grep.ts", "p/missing.ts"],
		});
	});

	it("rewrites tool result text and builds a legend", () => {
		const messages = [
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "bash",
				content: [
					{
						type: "text",
						text: "packages/coding-agent/src/core/tools/grep.ts:125:name",
					},
				],
				isError: false,
				timestamp: 0,
			},
		] as AgentMessage[];
		const aliased = applyPathAliases("/repo", messages);
		expect(aliased.legend).toBe("PATH ALIASES\np/grep.ts=packages/coding-agent/src/core/tools/grep.ts");
		const rewritten = aliased.messages[0];
		if (!rewritten || rewritten.role !== "toolResult") throw new Error("expected toolResult");
		const content = rewritten.content;
		expect(Array.isArray(content) && content[0] && "text" in content[0] ? content[0].text : "").toBe(
			"p/grep.ts:125:name",
		);
	});

	it("freezes alias ids when a colliding sibling later disappears", () => {
		let table = emptyPathAliasTable("/repo");
		const first = extendPathAliasTable(table, [
			"packages/coding-agent/src/foo.ts",
			"packages/coding-agent/test/foo.ts",
		]);
		expect(first.inserted.map((entry) => entry.id).sort()).toEqual(["p/src/foo.ts", "p/test/foo.ts"]);
		table = first.table;
		const second = extendPathAliasTable(table, ["packages/coding-agent/src/foo.ts"]);
		expect(second.inserted).toEqual([]);
		expect(table.entries.find((entry) => entry.path.endsWith("/src/foo.ts"))?.id).toBe("p/src/foo.ts");
	});

	it("does not reuse a reserved full-path alias when every suffix is taken", () => {
		let table = emptyPathAliasTable("/repo");
		const first = extendPathAliasTable(table, ["a/b/foo.ts"]);
		expect(first.inserted.map((entry) => entry.id)).toEqual(["p/foo.ts"]);
		table = first.table;
		const second = extendPathAliasTable(table, ["a/src/foo.ts"]);
		expect(second.inserted.map((entry) => entry.id)).toEqual(["p/src/foo.ts"]);
		table = second.table;
		const third = extendPathAliasTable(table, ["a/coding-agent/src/foo.ts"]);
		expect(third.inserted.map((entry) => entry.id)).toEqual(["p/coding-agent/src/foo.ts"]);
		table = third.table;
		const fourth = extendPathAliasTable(table, ["coding-agent/src/foo.ts"]);
		expect(fourth.inserted).toHaveLength(1);
		expect(fourth.inserted[0]?.path).toBe("coding-agent/src/foo.ts");
		expect(fourth.inserted[0]?.id).not.toBe("p/foo.ts");
		expect(fourth.inserted[0]?.id).not.toBe("p/src/foo.ts");
		expect(fourth.inserted[0]?.id).not.toBe("p/coding-agent/src/foo.ts");
		const ids = fourth.table.entries.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("still assigns the shortest free suffix when reserved ids do not cover it", () => {
		let table = emptyPathAliasTable("/repo");
		table = extendPathAliasTable(table, ["a/b/foo.ts"]).table;
		const inserted = extendPathAliasTable(table, ["a/b/unique-name.ts"]).inserted;
		expect(inserted).toEqual([{ id: "p/unique-name.ts", path: "a/b/unique-name.ts" }]);
	});

	it("rewrites overlapping alias paths in one pass without cascading corruption", () => {
		const table = buildPathAliasTable("/repo", ["packages/coding-agent/src/context/foo.ts and src/context/foo.ts"]);
		const byPath = new Map(table.entries.map((entry) => [entry.path, entry.id]));
		expect(byPath.get("packages/coding-agent/src/context/foo.ts")).toBe("p/coding-agent/src/context/foo.ts");
		expect(byPath.get("src/context/foo.ts")).toBe("p/2/src/context/foo.ts");
		expect(rewriteText(table, "packages/coding-agent/src/context/foo.ts and src/context/foo.ts")).toBe(
			"p/coding-agent/src/context/foo.ts and p/2/src/context/foo.ts",
		);
	});

	it("respects token boundaries when rewriting", () => {
		const table = buildPathAliasTable("/repo", ["packages/coding-agent/src/core/tools/grep.ts"]);
		expect(rewriteText(table, "prefix-packages/coding-agent/src/core/tools/grep.ts")).toBe(
			"prefix-packages/coding-agent/src/core/tools/grep.ts",
		);
		expect(rewriteText(table, "packages/coding-agent/src/core/tools/grep.ts.bak")).toBe(
			"packages/coding-agent/src/core/tools/grep.ts.bak",
		);
		expect(rewriteText(table, "see packages/coding-agent/src/core/tools/grep.ts.")).toBe("see p/grep.ts.");
	});

	it("aliases home-relative ~/ paths from their tilde text form", () => {
		const table = buildPathAliasTable("/repo", ["see ~/workspace/screenshots/latest-capture.png"]);
		expect(table.entries).toHaveLength(1);
		const entry = table.entries[0];
		expect(entry?.id).toBe("p/latest-capture.png");
		expect(entry?.path.endsWith("workspace/screenshots/latest-capture.png")).toBe(true);
		expect(entry?.path.startsWith("~")).toBe(false);
		expect(rewriteText(table, "see ~/workspace/screenshots/latest-capture.png")).toBe("see p/latest-capture.png");
	});

	it("still aliases ~/ text when the display picker already chose the absolute spelling", () => {
		// Reproduces the Windows CI failure mode: cwd unrelated to home makes the
		// cwd-relative display longer than the absolute one, so buildPathAliasTable
		// stores an already-absolute entry.path. The ~/ text form must still be found.
		const home = homedir().replace(/\\/g, "/");
		const table: PathAliasTable = {
			cwd: "/unrelated/cwd/far/from/home",
			entries: [{ id: "p/x.ts", path: `${home}/workspace/x.ts` }],
		};
		expect(rewriteText(table, "read ~/workspace/x.ts")).toBe("read p/x.ts");
		expect(rewriteText(table, `read ${home}/workspace/x.ts`)).toBe("read p/x.ts");
	});

	it("captures long single-separator relative paths but not MIME types", () => {
		expect(extractPathCandidates("see packages/coding-agent")).toEqual(["packages/coding-agent"]);
		expect(extractPathCandidates("Content-Type: application/octet-stream")).toEqual([]);
		expect(extractPathCandidates("application/x-www-form-urlencoded body")).toEqual([]);
		expect(extractPathCandidates('import x from "@caupulican/pi-agent-core";')).toEqual([
			"@caupulican/pi-agent-core",
		]);
	});

	it("extracts and rewrites paths adjacent to shell operators and table pipes", () => {
		const path = "packages/coding-agent/src/core/tools/grep.ts";
		expect(extractPathCandidates(`cat foo.txt|${path}`)).toEqual([path]);
		expect(extractPathCandidates(`|${path}|note|`)).toEqual([path]);
		expect(extractPathCandidates(`run 2>${path}.log`)).toEqual([`${path}.log`]);
		expect(extractPathCandidates(`cd /tmp;${path}`)).toEqual([path]);
		const table = buildPathAliasTable("/repo", [`read ${path}`]);
		expect(rewriteText(table, `cat ${path} | wc -l`)).toBe("cat p/grep.ts | wc -l");
		expect(rewriteText(table, `cat foo.txt|${path}`)).toBe("cat foo.txt|p/grep.ts");
		expect(rewriteText(table, `|${path}|note|`)).toBe("|p/grep.ts|note|");
	});

	it("cuts Windows candidates at line-number and diagnostic suffixes", () => {
		const win = String.raw`C:\repo\src\foo-component.ts`;
		expect(extractPathCandidates(`${win}:125:match`)).toEqual([win]);
		expect(extractPathCandidates(`${win}(12,5): error TS2345`)).toEqual([win]);
		const table = buildPathAliasTable("/repo", [`${win}:125`]);
		expect(table.entries).toEqual([{ id: "p/foo-component.ts", path: "C:/repo/src/foo-component.ts" }]);
		expect(rewriteText(table, `${win}:125:match`)).toBe("p/foo-component.ts:125:match");
	});

	it("keeps drive segments out of alias ids when tails collide across drives", () => {
		const table = buildPathAliasTable("/repo", [String.raw`compare C:\proj\src\foo.ts with D:\proj\src\foo.ts`]);
		expect(table.entries).toHaveLength(2);
		expect(new Set(table.entries.map((entry) => entry.id)).size).toBe(2);
		for (const entry of table.entries) {
			expect(entry.id).toMatch(/^p\/(?:[\w.+@~%-]+\/)*[\w.+@~%-]+$/);
			expect(expandText(table, entry.id)).toBe(entry.path);
		}
	});

	it("does not alias displays that are no longer than their alias", () => {
		const cwd = "/srv/checkout/product";
		const table = buildPathAliasTable(cwd, [`repo at ${cwd} holds ${cwd}/a.ts`]);
		expect(table.entries).toEqual([]);
		expect(rewriteText(table, "git add . && ls .")).toBe("git add . && ls .");
	});

	it("never rewrites legacy entries whose ids cannot round-trip", () => {
		const table: PathAliasTable = {
			cwd: "/repo",
			entries: [
				{ id: "p/foo-component.ts:125", path: "C:/repo/src/foo-component.ts:125" },
				{ id: "p/.", path: "." },
			],
		};
		expect(rewriteText(table, String.raw`see C:\repo\src\foo-component.ts:125 here`)).toBe(
			String.raw`see C:\repo\src\foo-component.ts:125 here`,
		);
		expect(rewriteText(table, "git add .")).toBe("git add .");
		expect(expandText(table, "open p/.")).toBe("open p/.");
	});

	it("rewrites full absolute mentions to a single alias token", () => {
		// A real OS-absolute path (drive-letter-bearing on Windows), not a literal posix
		// "/srv/..." string — node:path treats a bare leading "/" as current-drive-relative
		// on Windows, so it would not actually be absolute there and the text's own
		// embedded mention would never match the computed absolute form.
		const cwd = pathResolve("/srv/checkout/product").replaceAll("\\", "/");
		const rel = "packages/coding-agent/src/core/context/path-alias-table.ts";
		const table = buildPathAliasTable(cwd, [`read ${cwd}/${rel}`]);
		expect(table.entries).toEqual([{ id: "p/path-alias-table.ts", path: rel }]);
		expect(rewriteText(table, `read ${cwd}/${rel}`)).toBe("read p/path-alias-table.ts");
		expect(rewriteText(table, `read ${rel}`)).toBe("read p/path-alias-table.ts");
	});

	it("is safe around p-suffixed segments and the reserved p/ namespace", () => {
		const table = buildPathAliasTable("/repo", ["see contap/contadp/ts.tsx here"]);
		expect(table.entries).toEqual([{ id: "p/ts.tsx", path: "contap/contadp/ts.tsx" }]);
		const rewritten = rewriteText(table, "see contap/contadp/ts.tsx here");
		expect(rewritten).toBe("see p/ts.tsx here");
		expect(expandText(table, rewritten)).toBe("see contap/contadp/ts.tsx here");
		expect(extractPathCandidates("open p/contadp/ts.tsx")).toEqual([]);
		expect(rewriteText(table, "open p/contadp/ts.tsx")).toBe("open p/contadp/ts.tsx");
		const mid = buildPathAliasTable("/repo", ["read src/p/util-helpers.ts now"]);
		expect(rewriteText(mid, "read src/p/util-helpers.ts now")).toBe("read p/util-helpers.ts now");
		expect(expandText(mid, "read p/util-helpers.ts now")).toBe("read src/p/util-helpers.ts now");
	});

	it("round-trips paths behind colon and comma delimiters without prefix mangling", () => {
		const table = buildPathAliasTable("/repo", [
			"see packages/coding-agent then git show HEAD:packages/coding-agent/src/index.ts",
		]);
		const byPath = new Map(table.entries.map((entry) => [entry.path, entry.id]));
		expect(byPath.get("packages/coding-agent")).toBe("p/coding-agent");
		expect(byPath.get("packages/coding-agent/src/index.ts")).toBe("p/index.ts");
		const rewritten = rewriteText(table, "git show HEAD:packages/coding-agent/src/index.ts");
		expect(rewritten).toBe("git show HEAD:p/index.ts");
		expect(expandText(table, rewritten)).toBe("git show HEAD:packages/coding-agent/src/index.ts");
		expect(extractPathCandidates("--files a.ts,packages/coding-agent/src/index.ts")).toEqual([
			"packages/coding-agent/src/index.ts",
		]);
		// a shorter entry must never rewrite a prefix inside a longer unregistered path
		const short = buildPathAliasTable("/repo", ["see packages/coding-agent"]);
		expect(rewriteText(short, "git show HEAD:packages/coding-agent/src/index.ts")).toBe(
			"git show HEAD:packages/coding-agent/src/index.ts",
		);
	});

	it("keeps sentence-final aliases in the active legend and expandable", () => {
		const messages = [
			{
				role: "user",
				content: [{ type: "text", text: "see packages/coding-agent/src/core/tools/grep.ts." }],
				timestamp: 1,
			},
		] as AgentMessage[];
		const aliased = applyPathAliases("/repo", messages);
		expect(aliased.legend).toBe("PATH ALIASES\np/grep.ts=packages/coding-agent/src/core/tools/grep.ts");
		const table = buildPathAliasTable("/repo", ["see packages/coding-agent/src/core/tools/grep.ts."]);
		expect(expandText(table, "see p/grep.ts.")).toBe("see packages/coding-agent/src/core/tools/grep.ts.");
	});

	it("never aliases real files under a p/ directory registered via absolute mentions", () => {
		const table = buildPathAliasTable("/repo", [
			"read /repo/p/utils/foo.ts and packages/coding-agent/src/core/tools/grep.ts",
		]);
		expect(table.entries).toEqual([{ id: "p/grep.ts", path: "packages/coding-agent/src/core/tools/grep.ts" }]);
		expect(table.reservedIds).toContain("p/utils/foo.ts");
		expect(rewriteText(table, "ls $(pwd)/p/utils/foo.ts")).toBe("ls $(pwd)/p/utils/foo.ts");
		expect(rewriteText(table, "read /repo/p/utils/foo.ts")).toBe("read /repo/p/utils/foo.ts");
		// a legacy entry whose display lives in the p/ namespace must not enter the map
		const legacy: PathAliasTable = { cwd: "/repo", entries: [{ id: "p/foo.ts", path: "p/utils/foo.ts" }] };
		expect(rewriteText(legacy, "ls $(pwd)/p/utils/foo.ts")).toBe("ls $(pwd)/p/utils/foo.ts");
	});

	it("does not extract phantom posix candidates from forward-slash windows paths", () => {
		expect(extractPathCandidates("read C:/Users/me/project/file-name.ts")).toEqual([
			"C:/Users/me/project/file-name.ts",
		]);
	});

	it("does not fail when a repo has a real p/ directory", () => {
		const table = buildPathAliasTable("/repo", ["read p/config-loader.ts and src/lib/config-loader.ts"]);
		expect(table.entries).toEqual([{ id: "p/lib/config-loader.ts", path: "src/lib/config-loader.ts" }]);
		expect(rewriteText(table, "read p/config-loader.ts")).toBe("read p/config-loader.ts");
		expect(expandText(table, "read p/config-loader.ts")).toBe("read p/config-loader.ts");
		expect(expandText(table, "read p/lib/config-loader.ts")).toBe("read src/lib/config-loader.ts");
	});

	it("expands only standalone tokens and is idempotent when parsing back", () => {
		const table = buildPathAliasTable("/repo", ["read src/p/util-helpers.ts now"]);
		expect(expandText(table, "read src/p/util-helpers.ts now")).toBe("read src/p/util-helpers.ts now");
		const once = expandText(table, "read p/util-helpers.ts now");
		expect(once).toBe("read src/p/util-helpers.ts now");
		expect(expandText(table, once)).toBe(once);
	});

	it("rewrites dot-relative spellings and leaves unknown absolute prefixes untouched", () => {
		const table = buildPathAliasTable("/repo", ["read packages/coding-agent/src/core/tools/grep.ts"]);
		expect(rewriteText(table, "see ./packages/coding-agent/src/core/tools/grep.ts")).toBe("see p/grep.ts");
		expect(rewriteText(table, "see /other-root/packages/coding-agent/src/core/tools/grep.ts")).toBe(
			"see /other-root/packages/coding-agent/src/core/tools/grep.ts",
		);
	});

	it("is idempotent over already-aliased text", () => {
		const table = buildPathAliasTable("/repo", ["packages/coding-agent/src/context/foo.ts and src/context/foo.ts"]);
		const once = rewriteText(table, "packages/coding-agent/src/context/foo.ts and src/context/foo.ts");
		expect(once).toBe("p/coding-agent/src/context/foo.ts and p/2/src/context/foo.ts");
		expect(rewriteText(table, once)).toBe(once);
		expect(rewriteText(table, "I edited p/2/src/context/foo.ts earlier")).toBe(
			"I edited p/2/src/context/foo.ts earlier",
		);
	});

	it("handles an archive-listing-sized message without quadratic blowup", () => {
		// Regression pin for a real hang: a single tool result listing thousands of
		// Windows paths (a 7z archive listing) made candidate dedupe and suffix-clash
		// detection quadratic — 10s+ at this size, minutes at real sizes. The linear
		// implementation finishes well inside the default test timeout.
		const lines: string[] = [];
		for (let i = 0; i < 6000; i++) {
			lines.push(String.raw`C:\Users\Dev\Downloads\archive\dir-${i % 40}\file-${i}.json`);
		}
		const table = buildPathAliasTable("/repo", [lines.join("\n")]);
		expect(table.entries).toHaveLength(6000);
		expect(new Set(table.entries.map((entry) => entry.id)).size).toBe(6000);
	});

	it("keeps case-differing posix paths distinct and windows case variants deduped", () => {
		const posix = buildPathAliasTable("/repo", ["packages/app/src/Types.ts and packages/app/src/types.ts"]);
		// dedupeKey is host-aware: case-sensitive on a posix host (matching ext4/APFS-style
		// semantics, including WSL where process.platform is "linux"), case-insensitive on
		// a native win32 host (matching NTFS, where the two mentions really are one file).
		if (process.platform === "win32") {
			expect(posix.entries).toHaveLength(1);
		} else {
			expect(posix.entries.map((entry) => entry.id).sort()).toEqual(["p/Types.ts", "p/types.ts"].sort());
		}
		const windows = buildPathAliasTable("/repo", [
			String.raw`C:\Users\Dev\Downloads\notes-archive.txt then c:\users\dev\downloads\NOTES-ARCHIVE.TXT`,
		]);
		expect(windows.entries).toHaveLength(1);
	});
});

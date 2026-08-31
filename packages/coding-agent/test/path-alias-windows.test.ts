import { describe, expect, it } from "vitest";
import {
	buildPathAliasTable,
	expandText,
	extractPathCandidates,
	rewriteText,
} from "../src/core/context/path-alias-table.ts";

/**
 * Windows-shape behavior of the alias engine.
 *
 * These run identically on posix and win32: every case feeds Windows-shaped TEXT, which the
 * engine must handle on any host (a Linux/WSL session routinely reads Windows paths out of
 * tool output). Reproduced on a real win32 host before being written.
 *
 * The defect class they pin: `extractPathCandidates` + `displayPath` NORMALIZE a mention
 * (backslashes folded to `/`, drive-letter paths case-folded by `dedupeKey`) before minting an
 * entry, while `compileRewriter` matches a fixed set of LITERAL forms, separator-exactly and
 * case-sensitively. So extraction's accepted space is strictly larger than rewriting's. Any
 * mention that normalizes onto a known display but is not byte-identical to a generated form
 * mints an entry (and a legend line) that is then never used for that mention — the text keeps
 * the full raw path AND pays for the alias. That asymmetry also violates the engine's stated
 * invariant that rewriting and extraction share one boundary vocabulary.
 */
describe("path alias windows-shape rewriting", () => {
	it("rewrites a mention that mixes separators, having minted an entry for it", () => {
		const mixed = "C:\\Users\\me\\proj/src\\components/Panel.tsx";
		const text = `open ${mixed} now`;
		const table = buildPathAliasTable("/repo", [text]);

		// Extraction accepts it and mints an alias...
		expect(extractPathCandidates(text)).toContain(mixed);
		expect(table.entries).toHaveLength(1);
		const id = table.entries[0].id;

		// ...so the rewriter must actually use it, or we paid for the entry and the legend
		// line while leaving the full path in the text.
		expect(rewriteText(table, text)).toBe(`open ${id} now`);
	});

	it("rewrites every case variant of one Windows path to the single id it deduped into", () => {
		const canonical = String.raw`C:\Users\Dev\Downloads\notes-archive.txt`;
		const variant = String.raw`c:\users\dev\downloads\NOTES-ARCHIVE.TXT`;
		const text = `first ${canonical} then ${variant}`;
		const table = buildPathAliasTable("/repo", [text]);

		// One file on NTFS, so exactly one entry — this half already holds today.
		expect(table.entries).toHaveLength(1);
		const id = table.entries[0].id;

		// Both mentions must collapse to that id; otherwise the second one is billed in full
		// on every turn it survives.
		expect(rewriteText(table, text)).toBe(`first ${id} then ${id}`);
	});

	it("keeps case-differing posix paths distinct and never cross-rewrites them", () => {
		// Feature protection for the deliberate posix case-sensitivity: on a posix host these
		// are two different files and each keeps its own identity. Windows-shape tolerance
		// must not leak into posix displays.
		const text = "packages/app/src/Types.ts and packages/app/src/types.ts";
		const table = buildPathAliasTable("/repo", [text]);
		if (process.platform === "win32") {
			expect(table.entries).toHaveLength(1);
			return;
		}
		expect(table.entries).toHaveLength(2);
		const rewritten = rewriteText(table, text);
		const upper = table.entries.find((entry) => entry.path.endsWith("/Types.ts"));
		const lower = table.entries.find((entry) => entry.path.endsWith("/types.ts"));
		expect(upper && lower).toBeTruthy();
		expect(rewritten).toBe(`${upper?.id} and ${lower?.id}`);
		expect(expandText(table, rewritten)).toBe(text);
	});

	it("stays idempotent when rewriting Windows-shaped text", () => {
		const text = `see C:\\Users\\me\\proj\\src\\deep\\handler.ts and C:\\Users\\me\\proj/src/deep\\other.ts`;
		const table = buildPathAliasTable("/repo", [text]);
		const once = rewriteText(table, text);
		expect(rewriteText(table, once)).toBe(once);
	});

	it("aliases a path whose directory name contains a space, whole", () => {
		// Windows names routinely contain spaces ("My Project", "Program Files (x86)"). The path
		// must be captured in FULL and aliased. Capturing only the prefix before the space would
		// mint an id for a location that does not exist and then substitute it inside the real
		// mention, destroying the path the model is reading.
		const real = String.raw`C:\Users\Dev\Documents\My Project\src\file.ts`;
		const text = `open ${real} now`;
		const table = buildPathAliasTable("/repo", [text]);

		expect(extractPathCandidates(text)).toEqual([real]);
		expect(table.entries).toEqual([{ id: "p/file.ts", path: "C:/Users/Dev/Documents/My Project/src/file.ts" }]);
		expect(rewriteText(table, text)).toBe("open p/file.ts now");
		expect(expandText(table, rewriteText(table, text))).toBe(
			"open C:/Users/Dev/Documents/My Project/src/file.ts now",
		);
	});

	it("aliases a parenthesized filename, whole", () => {
		const real = String.raw`C:\Users\me\Downloads\report (1).pdf`;
		const text = `open ${real} now`;
		const table = buildPathAliasTable("/repo", [text]);

		expect(extractPathCandidates(text)).toEqual([real]);
		expect(table.entries[0].path).toBe("C:/Users/me/Downloads/report (1).pdf");
		// The id must stay inside the alias-token alphabet even though the display is not.
		const id = table.entries[0].id;
		expect(id).toMatch(/^p\/[\w.+@~%-]+$/);
		expect(rewriteText(table, text)).toBe(`open ${id} now`);
		expect(expandText(table, `open ${id} now`)).toBe("open C:/Users/me/Downloads/report (1).pdf now");
	});

	it("aliases Program Files (x86) paths, whole", () => {
		const real = String.raw`C:\Program Files (x86)\Vendor App\bin\tool.exe`;
		const text = `run ${real} please`;
		const table = buildPathAliasTable("/repo", [text]);

		expect(extractPathCandidates(text)).toEqual([real]);
		expect(table.entries[0].path).toBe("C:/Program Files (x86)/Vendor App/bin/tool.exe");
		expect(rewriteText(table, text)).toBe(`run ${table.entries[0].id} please`);
	});

	it("does not alias prose that merely straddles separators", () => {
		// A spaced candidate needs evidence for the candidate as a whole; an extension in later
		// prose ("Node.js") must not launder an ordinary phrase into a filename.
		for (const prose of [
			"see the src/lib and docs/api sections",
			"we changed the config/settings today",
			"compare packages/app and packages/core now",
			"Use extensions/packages only. npm and Node.js are supported.",
		]) {
			const table = buildPathAliasTable("/repo", [prose]);
			expect(table.entries, prose).toEqual([]);
			expect(rewriteText(table, prose), prose).toBe(prose);
		}
	});

	it("keeps the punctuation-free prose/path ambiguity explicit", () => {
		// This is lexically identical to a valid unquoted relative filename
		// `extensions/packages only with Node.js`. Rejecting it would also reject that supported
		// filename class, so the owning boundary deliberately fixes only the sentence-punctuation
		// case above rather than adding prose-word heuristics.
		const ambiguous = "Use extensions/packages only with Node.js";
		expect(extractPathCandidates(ambiguous)).toEqual(["extensions/packages only with Node.js"]);
	});

	it("still aliases a legitimate relative path with spaced and parenthesized filename", () => {
		const real = "artifacts/reports/release notes (final).md";
		const text = `open ${real} now`;
		const table = buildPathAliasTable("/repo", [text]);

		expect(extractPathCandidates(text)).toEqual([real]);
		expect(table.entries).toHaveLength(1);
		expect(rewriteText(table, text)).toBe(`open ${table.entries[0].id} now`);
	});

	it("strips a closing paren that is punctuation but keeps one that is part of the name", () => {
		const parenthetical = String.raw`(see C:\Users\me\proj\src\alpha.ts)`;
		const table = buildPathAliasTable("/repo", [parenthetical]);
		expect(table.entries[0].path).toBe("C:/Users/me/proj/src/alpha.ts");

		const realParens = String.raw`C:\Users\me\proj\Backup (old)\notes.txt`;
		const table2 = buildPathAliasTable("/repo", [`open ${realParens}`]);
		expect(table2.entries[0].path).toBe("C:/Users/me/proj/Backup (old)/notes.txt");
	});

	it("still aliases a space-free path that is merely followed by prose", () => {
		// Negative control for the guard above: a trailing space must not stop a legitimate alias.
		const real = String.raw`C:\Users\me\proj\src\deep\thing.ts`;
		const table = buildPathAliasTable("/repo", [`open ${real} now`]);
		expect(table.entries).toHaveLength(1);
		expect(rewriteText(table, `open ${real} now`)).toBe(`open ${table.entries[0].id} now`);
	});

	it("still aliases two paths separated by prose", () => {
		const first = String.raw`C:\Users\me\proj\src\alpha.ts`;
		const second = String.raw`C:\Users\me\proj\src\beta.ts`;
		const text = `compare ${first} and ${second} please`;
		const table = buildPathAliasTable("/repo", [text]);
		expect(table.entries).toHaveLength(2);
		const rewritten = rewriteText(table, text);
		expect(rewritten).not.toContain("C:\\Users");
		expect(expandText(table, rewritten)).toBe(text.replaceAll("\\", "/"));
	});

	it("does not let a separator-tolerant entry mangle a longer unregistered path", () => {
		// The lookbehind/lookahead guards must survive separator tolerance: an entry for
		// `...\src\a.ts` must not match inside a deeper unregistered path.
		const registered = String.raw`C:\Users\me\proj\src\a.ts`;
		const table = buildPathAliasTable("/repo", [`open ${registered}`]);
		expect(table.entries).toHaveLength(1);

		const deeper = String.raw`C:\Users\me\proj\src\a.ts.bak`;
		expect(rewriteText(table, `open ${deeper}`)).toBe(`open ${deeper}`);
	});
});

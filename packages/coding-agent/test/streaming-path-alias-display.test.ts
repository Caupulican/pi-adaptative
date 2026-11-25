import { expect, it } from "vitest";
import { expandMessageTextForDisplay, StreamingPathAliasDisplay } from "../src/core/context/path-alias-display.ts";
import type { PathAliasTable } from "../src/core/context/path-alias-table.ts";
import type { AgentMessage } from "../src/kernel/types.ts";

it("matches full display expansion across token seams, source replacement and legend changes", () => {
	const display = new StreamingPathAliasDisplay();
	const legend: PathAliasTable = {
		cwd: "/project",
		entries: [
			{ id: "p/file", path: "src/deep/file.ts" },
			{ id: "p/file/name", path: "src/deep/other.ts" },
		],
	};
	const check = (content: string, table = legend) => {
		const message: AgentMessage = { role: "user", content, timestamp: 1 };
		expect(display.expand(table, message)).toEqual(expandMessageTextForDisplay(table, message));
	};
	for (const text of [
		"file: p/",
		"file: p/file",
		"file: p/file/",
		"file: p/file/name",
		"file: p/file/name and !p/file",
		"p/file.",
	]) {
		check(text);
	}
	check("p/file.", { ...legend, entries: [{ id: "p/file", path: "src/new.ts" }] });
});

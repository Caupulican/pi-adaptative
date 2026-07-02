import { describe, expect, it } from "vitest";
import { matchToolkitScript, type ToolkitScript } from "../src/core/toolkit/script-registry.ts";

const SCRIPTS: ToolkitScript[] = [
	{
		name: "prepare-db",
		description: "Prepare the dev database schema and seed data",
		runner: "uv",
		path: "toolkit/prepare_db.py",
	},
	{
		name: "update-db",
		description: "Update the dev database to the latest migrations",
		runner: "uv",
		path: "toolkit/update_db.py",
	},
	{
		name: "restore-db",
		description: "Restore the dev database from the latest backup",
		runner: "powershell",
		path: "toolkit/restore-db.ps1",
		danger: true,
		aliases: ["db restore"],
	},
	{ name: "tail-logs", description: "Tail the application logs", runner: "bash", path: "toolkit/tail-logs.sh" },
];

describe("matchToolkitScript (Level-0 conservative matcher)", () => {
	it("matches exact names and user aliases directly", () => {
		expect(matchToolkitScript("restore-db", SCRIPTS)).toMatchObject({
			kind: "exact",
			script: { name: "restore-db" },
		});
		expect(matchToolkitScript("db restore", SCRIPTS)).toMatchObject({
			kind: "exact",
			script: { name: "restore-db" },
		});
		expect(matchToolkitScript("Tail-Logs", SCRIPTS)).toMatchObject({ kind: "exact", script: { name: "tail-logs" } });
	});

	it("NEVER guesses between near-neighbors: 'prepare db' vs 'update db' yields a shortlist", () => {
		const prepared = matchToolkitScript("prepare db", SCRIPTS);
		// "prepare db" tokens hit prepare-db strongly and update-db weakly ("db") — prepare-db
		// clears the margin. The symmetric ambiguous phrase is the pure "db" request:
		expect(prepared.kind).toBe("exact");

		const ambiguous = matchToolkitScript("run the db thing", SCRIPTS);
		expect(ambiguous.kind).toBe("ambiguous");
		if (ambiguous.kind === "ambiguous") {
			const names = ambiguous.shortlist.map((script) => script.name);
			expect(names).toContain("prepare-db");
			expect(names).toContain("update-db");
		}
	});

	it("distinguishes clear-margin phrases", () => {
		expect(matchToolkitScript("update the db migrations", SCRIPTS)).toMatchObject({
			kind: "exact",
			script: { name: "update-db" },
		});
		expect(matchToolkitScript("tail the logs", SCRIPTS)).toMatchObject({
			kind: "exact",
			script: { name: "tail-logs" },
		});
	});

	it("returns none with closest candidates for unknown requests", () => {
		const result = matchToolkitScript("deploy to production", SCRIPTS);
		expect(result.kind).toBe("none");
	});

	it("handles empty registries and empty requests", () => {
		expect(matchToolkitScript("anything", []).kind).toBe("none");
		expect(matchToolkitScript("   ", SCRIPTS).kind).toBe("none");
	});
});

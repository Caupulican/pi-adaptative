import { describe, expect, it } from "vitest";
import { acceptReflexPlan, buildReflexUserPrompt, parseReflexPlan } from "../src/core/toolkit/reflex-interpreter.ts";
import type { ToolkitScript } from "../src/core/toolkit/script-registry.ts";
import { createRunToolkitScriptToolDefinition } from "../src/core/tools/run-toolkit-script.ts";

const SCRIPTS: ToolkitScript[] = [
	{
		name: "prepare-db",
		description: "Prepare a fresh dev database schema and seed data",
		runner: "bash",
		path: "a.sh",
	},
	{
		name: "update-db",
		description: "Apply pending migrations to bring the database schema up to date",
		runner: "bash",
		path: "b.sh",
	},
	{ name: "restore-db", description: "Restore a database from backup", runner: "bash", path: "c.sh", danger: true },
];

describe("reflex interpreter parsing and acceptance", () => {
	it("parses strict plans, strips think blocks, clamps confidence", () => {
		expect(parseReflexPlan('{"script":"update-db","args":["staging"],"danger":false,"confidence":0.9}')).toEqual({
			script: "update-db",
			args: ["staging"],
			danger: false,
			confidence: 0.9,
		});
		expect(parseReflexPlan('<think>hmm</think>{"script":"update-db","args":[],"confidence":7}')).toMatchObject({
			script: "update-db",
			confidence: 1,
		});
		expect(parseReflexPlan("no json at all")).toBeUndefined();
	});

	it("accepts only confident plans naming REAL registry scripts", () => {
		expect(
			acceptReflexPlan({ script: "update-db", args: [], danger: false, confidence: 0.9 }, SCRIPTS)?.script.name,
		).toBe("update-db");
		expect(
			acceptReflexPlan({ script: "update-db", args: [], danger: false, confidence: 0.5 }, SCRIPTS),
		).toBeUndefined();
		expect(acceptReflexPlan({ script: "rm-rf", args: [], danger: false, confidence: 1 }, SCRIPTS)).toBeUndefined();
		expect(acceptReflexPlan({ script: "none", args: [], danger: false, confidence: 0 }, SCRIPTS)).toBeUndefined();
	});

	it("builds a bounded registry prompt with danger flags", () => {
		const prompt = buildReflexUserPrompt("bring schema current", SCRIPTS);
		expect(prompt).toContain("restore-db: Restore a database from backup [DANGEROUS]");
		expect(prompt).toContain("Request: bring schema current");
	});
});

describe("run_toolkit_script with the reflex brain", () => {
	const execute = async () => ({ exitCode: 0, stdout: "done", stderr: "", durationMs: 5, timedOut: false });
	const run = (input: object, interpret?: (request: string) => Promise<ReturnType<typeof parseReflexPlan>>) => {
		const tool = createRunToolkitScriptToolDefinition({
			getScripts: () => SCRIPTS,
			execute,
			interpret: interpret ? (request) => interpret(request) : undefined,
		});
		return tool.execute("tc-1", input as never, undefined as never, undefined as never, undefined as never);
	};

	it("resolves an ambiguous request through a confident brain plan", async () => {
		const result = await run({ script: "get the db schema current please thanks" }, async () => ({
			script: "update-db",
			args: [],
			danger: false,
			confidence: 0.92,
		}));
		expect(JSON.stringify(result.details)).toContain('"interpreter"');
		expect(JSON.stringify(result.details)).toContain("update-db");
		expect((result as { isError?: boolean }).isError ?? false).toBe(false);
	});

	it("keeps the shortlist when the brain is absent or unconfident", async () => {
		const noBrain = await run({ script: "get the db schema current please thanks" });
		expect((noBrain.details as { outcome: string }).outcome).toBe("ambiguous");
		const shyBrain = await run({ script: "get the db schema current please thanks" }, async () => ({
			script: "update-db",
			args: [],
			danger: false,
			confidence: 0.4,
		}));
		expect((shyBrain.details as { outcome: string }).outcome).toBe("ambiguous");
	});

	it("brain-selected DANGEROUS scripts still require explicit confirmation", async () => {
		const result = await run({ script: "bring the database back from the backup please" }, async () => ({
			script: "restore-db",
			args: ["staging"],
			danger: true,
			confidence: 0.95,
		}));
		expect((result.details as { outcome: string }).outcome).toBe("confirmation_required");
	});
});

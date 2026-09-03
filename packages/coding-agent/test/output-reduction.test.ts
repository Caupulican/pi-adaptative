/**
 * The reduction registry: one decision for the bash tool, the python tool and the census. Reducers
 * are pure; the registry refuses verbose commands, refuses reductions that are not materially smaller,
 * and describes every reduction it makes in the shape the census reads.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	formatOutputReductionNotice,
	type OutputReducer,
	reduceToolOutput,
	registeredOutputReducers,
	registerOutputReducer,
} from "../src/core/tools/output-reduction.ts";

const testReducer: OutputReducer = {
	name: "test-halver",
	applies: (classification) => classification.tool === "halveme",
	reduce: (_classification, request) => {
		const lines = request.text.split("\n").filter((line) => line.length > 0);
		const kept = lines.slice(0, Math.ceil(lines.length / 2));
		return { text: `${kept.join("\n")}\n`, omittedLines: lines.length - kept.length };
	},
};

afterEach(() => {
	// Registration is idempotent by name; re-registering a no-op reducer keeps the registry clean.
	registerOutputReducer({ ...testReducer, applies: () => false });
});

describe("reduceToolOutput", () => {
	it("returns undefined when no reducer applies and the generic stage changes nothing", () => {
		expect(
			reduceToolOutput({ tool: "bash", command: "some-tool run", text: "a\nb\n", exitCode: 0, level: "standard" }),
		).toBeUndefined();
	});

	it("runs the generic stage alone on any command when it saves enough", () => {
		const text = `${Array.from({ length: 30 }, () => "\u001b[32mprogress\u001b[0m   ").join("\n")}\ndone\n`;
		const result = reduceToolOutput({ tool: "bash", command: "some-tool run", text, exitCode: 0, level: "standard" });
		expect(result?.text).toBe("progress\n[line repeated 30 times]\ndone\n");
		expect(result?.details).toMatchObject({
			kind: "generic",
			family: "some-tool",
			omittedLines: 29,
			persistRaw: true,
		});
	});

	it("persists the raw output only when lines were dropped and the cut is worth a file", () => {
		const small = "x\nx\nx\nend\n";
		expect(
			reduceToolOutput({ tool: "bash", command: "some-tool", text: small, exitCode: 0, level: "standard" }),
		).toBeUndefined();
		const large = `${Array.from({ length: 300 }, () => "same line of output").join("\n")}\n`;
		const result = reduceToolOutput({
			tool: "bash",
			command: "some-tool",
			text: large,
			exitCode: 0,
			level: "standard",
		});
		expect(result?.details.persistRaw).toBe(true);
		expect(result?.details.omittedLines).toBe(299);
	});

	it("tries the extra reducers after the registered ones", () => {
		const rule: OutputReducer = {
			name: "rule",
			applies: (classification) => classification.tool === "my-build",
			reduce: (_classification, request) => ({
				text: request.text
					.split("\n")
					.filter((line) => !line.startsWith("noise"))
					.join("\n"),
				omittedLines: request.text.split("\n").filter((line) => line.startsWith("noise")).length,
				kind: "rule:my-build",
			}),
		};
		const text = `${Array.from({ length: 20 }, (_, index) => `noise ${index}`).join("\n")}\nresult ok\n`;
		const result = reduceToolOutput(
			{ tool: "bash", command: "my-build --fast", text, exitCode: 0, level: "standard" },
			{ extraReducers: [rule] },
		);
		expect(result?.text).toBe("result ok\n");
		expect(result?.details.kind).toBe("rule:my-build");
	});

	it("runs the first applicable reducer and describes the reduction", () => {
		registerOutputReducer(testReducer);
		const text = Array.from({ length: 40 }, (_, index) => `line ${index}`)
			.join("\n")
			.concat("\n");
		const result = reduceToolOutput({ tool: "bash", command: "halveme --now", text, exitCode: 0, level: "standard" });
		expect(result).toBeDefined();
		expect(result?.details).toMatchObject({
			kind: "test-halver",
			family: "halveme",
			inputLines: 40,
			outputLines: 20,
			omittedLines: 20,
			persistRaw: false,
		});
		expect(result?.details.outputBytes).toBeLessThan(result?.details.inputBytes ?? 0);
		expect(registeredOutputReducers().some((reducer) => reducer.name === "test-halver")).toBe(true);
	});

	it("passes verbose commands through untouched", () => {
		registerOutputReducer(testReducer);
		expect(
			reduceToolOutput({
				tool: "bash",
				command: "halveme --verbose",
				text: "a\nb\nc\nd\n",
				exitCode: 0,
				level: "standard",
			}),
		).toBeUndefined();
	});

	it("drops a reduction that is not materially smaller", () => {
		registerOutputReducer({
			...testReducer,
			name: "test-trimmer",
			reduce: (_classification, request) => ({ text: request.text.slice(0, -1), omittedLines: 0 }),
		});
		expect(
			reduceToolOutput({ tool: "bash", command: "halveme", text: "abcdefghij\n", exitCode: 0, level: "standard" }),
		).toBeUndefined();
		registerOutputReducer({ ...testReducer, name: "test-trimmer", applies: () => false });
	});

	it("is deterministic: the same input yields byte-identical output and details", () => {
		registerOutputReducer(testReducer);
		const request = {
			tool: "bash",
			command: "halveme",
			text: "1\n2\n3\n4\n5\n6\n",
			exitCode: 0,
			level: "standard" as const,
		};
		expect(reduceToolOutput(request)).toEqual(reduceToolOutput(request));
	});
});

describe("formatOutputReductionNotice", () => {
	it("names the family, the retained lines and the recovery path without volatile fields", () => {
		expect(
			formatOutputReductionNotice({
				kind: "search",
				family: "rg",
				inputBytes: 1000,
				outputBytes: 300,
				inputLines: 50,
				outputLines: 18,
				omittedLines: 32,
				rawPath: "/tmp/pi-bash-1.log",
				persistRaw: true,
			}),
		).toBe("[rg output filtered: retained 18 of 50 lines. Full output: /tmp/pi-bash-1.log]");
	});

	it("appends the projection command after the raw path when the reducer offered one", () => {
		expect(
			formatOutputReductionNotice({
				kind: "json",
				family: "gh api",
				inputBytes: 20000,
				outputBytes: 1200,
				inputLines: 300,
				outputLines: 40,
				omittedLines: 260,
				rawPath: "/tmp/pi-bash-3.log",
				recoveryHint: "jq -c '.items[] | {id,status}'",
				persistRaw: true,
			}),
		).toBe(
			"[gh api output filtered: retained 40 of 300 lines. Full output: /tmp/pi-bash-3.log; project it with: jq -c '.items[] | {id,status}' /tmp/pi-bash-3.log]",
		);
	});

	it("names a regrouping that omitted nothing when the raw output was persisted", () => {
		expect(
			formatOutputReductionNotice({
				kind: "search",
				family: "rg",
				inputBytes: 8000,
				outputBytes: 5000,
				inputLines: 40,
				outputLines: 41,
				omittedLines: 0,
				rawPath: "/tmp/pi-bash-2.log",
				persistRaw: true,
			}),
		).toBe("[rg output filtered: 40 lines regrouped, none omitted. Full output: /tmp/pi-bash-2.log]");
	});

	it("is silent when nothing was omitted (pure cleaning)", () => {
		expect(
			formatOutputReductionNotice({
				kind: "generic",
				family: "ls",
				inputBytes: 1000,
				outputBytes: 800,
				inputLines: 50,
				outputLines: 50,
				omittedLines: 0,
				persistRaw: false,
			}),
		).toBeUndefined();
	});
});

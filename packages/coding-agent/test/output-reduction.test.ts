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
	it("returns undefined when no reducer applies", () => {
		expect(
			reduceToolOutput({ tool: "bash", command: "some-tool run", text: "a\nb\n", exitCode: 0, level: "standard" }),
		).toBeUndefined();
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
			}),
		).toBe("[rg output filtered: retained 18 of 50 lines. Full output: /tmp/pi-bash-1.log]");
	});
});

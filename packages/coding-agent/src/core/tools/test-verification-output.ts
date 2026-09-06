import type { VerificationRecord } from "@caupulican/pi-agent-core/verification-obligations";
import { StreamingLineDecoder } from "@caupulican/pi-ai/streaming-lines";
import { NodeVerificationParser } from "./node-verification-parser.ts";
import { VitestVerificationParser } from "./vitest-verification-parser.ts";

export type VerificationRunner = "vitest" | "node-test" | "command";
export type TestVerificationOutcome = "passed" | "failed" | "no_tests" | "unconfirmed";

export interface VerificationOutputParser {
	readonly executionOutcome: NonNullable<VerificationRecord["outcome"]>;
	observe(line: string): void;
	finish(expected: number, exitCode: number | null): TestVerificationOutcome;
}

/** One bounded raw-stream and terminal-evidence lifecycle, independent of runner and display projection. */
export class TestVerificationOutput {
	private readonly bytes = new TextDecoder("utf-8", { fatal: true });
	private readonly lines = new StreamingLineDecoder(16 * 1024);
	private readonly parsers: Array<{ parser: VerificationOutputParser; expected: number }>;
	private readonly stages: number;
	readonly evidence: "tests" | "command";
	private incomplete = false;
	private finished = false;
	private result: TestVerificationOutcome = "unconfirmed";
	private outcome: NonNullable<VerificationRecord["outcome"]> = "unconfirmed";

	constructor(runners: readonly VerificationRunner[]) {
		if (runners.length < 1 || runners.length > 1_000) throw new Error("Invalid verification stage count");
		if (runners.some((runner) => runner !== "vitest" && runner !== "node-test" && runner !== "command"))
			throw new Error("Unknown verification runner");
		this.stages = runners.length;
		this.evidence = runners.includes("command") ? "command" : "tests";
		this.parsers = [];
		for (const runner of ["vitest", "node-test"] as const) {
			const expected = runners.filter((candidate) => candidate === runner).length;
			if (expected)
				this.parsers.push({
					parser: runner === "vitest" ? new VitestVerificationParser() : new NodeVerificationParser(),
					expected,
				});
		}
	}

	get executionOutcome(): NonNullable<VerificationRecord["outcome"]> {
		return this.outcome;
	}

	append(data: Uint8Array): void {
		if (this.finished) throw new Error("Cannot append after verification output completes");
		if (this.incomplete || this.parsers.length === 0) return;
		try {
			for (let offset = 0; offset < data.length; offset += 16 * 1024) {
				for (const line of this.lines.push(
					this.bytes.decode(data.subarray(offset, offset + 16 * 1024), { stream: true }),
				)) {
					for (const { parser } of this.parsers) parser.observe(line);
				}
			}
		} catch {
			this.incomplete = true;
		}
	}

	finish(exitCode: number | null): TestVerificationOutcome {
		if (this.finished) return this.result;
		this.finished = true;
		if (!this.incomplete) {
			try {
				const lines = this.lines.push(this.bytes.decode());
				const last = this.lines.finish();
				if (last !== undefined) lines.push(last);
				for (const line of lines) for (const { parser } of this.parsers) parser.observe(line);
			} catch {
				this.incomplete = true;
			}
		}
		if (this.incomplete) return this.result;
		const results = this.parsers.map(({ parser, expected }) => parser.finish(expected, exitCode));
		this.result = results.includes("failed")
			? "failed"
			: results.includes("unconfirmed")
				? "unconfirmed"
				: results.includes("no_tests")
					? "no_tests"
					: exitCode === 0
						? "passed"
						: "failed";
		if (exitCode === null) return this.result;
		if (this.parsers.some(({ parser }) => parser.executionOutcome === "executed") || this.parsers.length === 0)
			this.outcome = "executed";
		else if (this.stages === 1 && this.parsers[0]?.parser.executionOutcome === "setup_failed")
			this.outcome = "setup_failed";
		return this.result;
	}
}

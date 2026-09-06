import type { VerificationRecord } from "@caupulican/pi-agent-core/verification-obligations";
import { stripAnsi } from "../../utils/ansi.ts";
import type { TestVerificationOutcome, VerificationOutputParser } from "./test-verification-output.ts";

const COUNT_NAMES = ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"] as const;

/** Node's TAP/spec terminal counts. Test names and nested TAP diagnostics cannot provide a witness. */
export class NodeVerificationParser implements VerificationOutputParser {
	private counts = new Map<string, number>();
	private summaries = 0;
	private failed = false;
	private empty = false;
	private executed = false;
	private incomplete = false;
	private missingFile = false;
	private finished = false;
	private expected = 0;
	private exitCode: number | null = null;

	get executionOutcome(): NonNullable<VerificationRecord["outcome"]> {
		if (!this.finished || this.incomplete || this.exitCode === null) return "unconfirmed";
		if (this.executed) return "executed";
		return this.expected === 1 &&
			this.missingFile &&
			this.summaries === 0 &&
			this.counts.size === 0 &&
			this.exitCode !== 0
			? "setup_failed"
			: "unconfirmed";
	}

	observe(raw: string): void {
		const line = stripAnsi(raw).trimEnd();
		if (/^Could not find ['"].+['"]$/u.test(line)) this.missingFile = true;
		const count = /^(?:#|ℹ) (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/u.exec(line);
		if (count) {
			const value = Number(count[2]);
			if (!Number.isSafeInteger(value) || this.counts.has(count[1])) this.incomplete = true;
			else this.counts.set(count[1], value);
			return;
		}
		if (!/^(?:#|ℹ) duration_ms \d+(?:\.\d+)?$/u.test(line)) return;
		if (!COUNT_NAMES.every((name) => this.counts.has(name))) {
			this.incomplete = true;
			return;
		}
		const countOf = (name: string) => this.counts.get(name)!;
		const executed = countOf("pass") + countOf("fail");
		const total = executed + countOf("cancelled") + countOf("skipped") + countOf("todo");
		if (!Number.isSafeInteger(total) || total !== countOf("tests")) this.incomplete = true;
		if (countOf("fail") > 0 || countOf("cancelled") > 0) this.failed = true;
		if (executed > 0) this.executed = true;
		else this.empty = true;
		this.summaries = Math.min(this.summaries + 1, 1_001);
		this.counts.clear();
	}

	finish(expected: number, exitCode: number | null): TestVerificationOutcome {
		this.expected = expected;
		this.exitCode = exitCode;
		this.finished = true;
		if (this.failed) return "failed";
		if (this.incomplete || this.counts.size > 0) return "unconfirmed";
		if (this.empty) return "no_tests";
		if (expected < 1 || this.summaries !== expected) return this.missingFile ? "no_tests" : "unconfirmed";
		return exitCode === 0 ? "passed" : "failed";
	}
}

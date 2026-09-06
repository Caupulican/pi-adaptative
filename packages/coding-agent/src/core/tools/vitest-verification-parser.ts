import type { VerificationRecord } from "@caupulican/pi-agent-core/verification-obligations";
import { stripAnsi } from "../../utils/ansi.ts";
import type { TestVerificationOutcome, VerificationOutputParser } from "./test-verification-output.ts";

/** Vitest summary syntax only; stream lifetime and evidence policy belong to TestVerificationOutput. */
export class VitestVerificationParser implements VerificationOutputParser {
	private summaries = 0;
	private empty = false;
	private noFilesNotice = false;
	private failed = false;
	private incomplete = false;
	private finished = false;
	private executed = false;
	private expectedSummaries = 0;

	/** Setup repair requires one complete empty invocation, never a partially executed compound. */
	get executionOutcome(): NonNullable<VerificationRecord["outcome"]> {
		if (!this.finished || this.incomplete) return "unconfirmed";
		if (this.executed) return "executed";
		if (this.expectedSummaries === 1 && this.noFilesNotice && !this.failed) return "setup_failed";
		return "unconfirmed";
	}

	finish(expectedSummaries: number, exitCode: number | null): TestVerificationOutcome {
		this.expectedSummaries = expectedSummaries;
		this.finished = true;
		if (this.failed) return "failed";
		if (this.incomplete) return "unconfirmed";
		if (this.empty) return "no_tests";
		if (this.summaries !== expectedSummaries || expectedSummaries < 1)
			return this.noFilesNotice ? "no_tests" : "unconfirmed";
		return exitCode === 0 ? "passed" : "failed";
	}

	observe(raw: string): void {
		const line = stripAnsi(raw).trim();
		if (/^Errors\s+[1-9]\d* errors?$/u.test(line)) this.failed = true;
		if (/^No test files found(?:,|$)/u.test(line)) this.noFilesNotice = true;
		if (/^Tests\s+no tests$/u.test(line)) this.noFilesNotice = true;
		const summary = /^(Tests|Test Files)\s+((?:\d+ (?:passed|failed|skipped|todo)(?:\s*\|\s*)?)+)\s+\((\d+)\)$/u.exec(
			line,
		);
		if (!summary) return;
		let executed = 0;
		let total = 0;
		const seen = new Set<string>();
		for (const part of summary[2].matchAll(/(\d+) (passed|failed|skipped|todo)/gu)) {
			const count = Number(part[1]);
			if (!Number.isSafeInteger(count) || seen.has(part[2])) {
				this.incomplete = true;
				return;
			}
			seen.add(part[2]);
			total += count;
			if (part[2] === "passed" || part[2] === "failed") executed += count;
			if (part[2] === "failed" && count > 0) this.failed = true;
		}
		if (!Number.isSafeInteger(total) || total !== Number(summary[3])) {
			this.incomplete = true;
			return;
		}
		if (summary[1] === "Tests") {
			if (executed > 0) this.executed = true;
			if (executed === 0) this.empty = true;
			this.summaries = Math.min(this.summaries + 1, 1_001);
		}
	}
}

import type { VerificationRecord } from "@caupulican/pi-agent-core/verification-obligations";
import { StreamingLineDecoder } from "@caupulican/pi-ai/streaming-lines";
import { stripAnsi } from "../../utils/ansi.ts";

export type VitestVerificationOutcome = "passed" | "failed" | "no_tests" | "unconfirmed";

/** Observes raw output before display projection; retains bounded counts, never test payloads. */
export class VitestVerificationOutput {
	private readonly bytes = new TextDecoder("utf-8", { fatal: true });
	private readonly lines = new StreamingLineDecoder(16 * 1024);
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

	append(data: Uint8Array): void {
		if (this.finished) throw new Error("Cannot append after verification output completes");
		if (this.incomplete) return;
		// Bound each decoder allocation even when a process emits one enormous chunk.
		try {
			for (let offset = 0; offset < data.length; offset += 16 * 1024) {
				for (const line of this.lines.push(
					this.bytes.decode(data.subarray(offset, offset + 16 * 1024), { stream: true }),
				)) {
					this.observe(line);
				}
			}
		} catch {
			// Oversized or undecodable output cannot provide a complete verification witness.
			this.incomplete = true;
		}
	}

	finish(expectedSummaries: number, exitCode: number | null): VitestVerificationOutcome {
		this.expectedSummaries = expectedSummaries;
		if (!this.finished && !this.incomplete) {
			try {
				for (const line of this.lines.push(this.bytes.decode())) this.observe(line);
				const final = this.lines.finish();
				if (final !== undefined) this.observe(final);
			} catch {
				this.incomplete = true;
			}
		}
		this.finished = true;
		if (this.failed) return "failed";
		if (this.incomplete) return "unconfirmed";
		if (this.empty) return "no_tests";
		if (this.summaries !== expectedSummaries || expectedSummaries < 1)
			return this.noFilesNotice ? "no_tests" : "unconfirmed";
		return exitCode === 0 ? "passed" : "failed";
	}

	private observe(raw: string): void {
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
			this.summaries = Math.min(this.summaries + 1, 1_000);
		}
	}
}

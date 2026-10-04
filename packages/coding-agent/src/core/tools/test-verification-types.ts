import type { VerificationRecord } from "../../kernel/verification-obligations.ts";

export type TestVerificationOutcome = "passed" | "failed" | "no_tests" | "unconfirmed";

export interface VerificationOutputParser {
	readonly executionOutcome: NonNullable<VerificationRecord["outcome"]>;
	observe(line: string): void;
	finish(expected: number, exitCode: number | null): TestVerificationOutcome;
}

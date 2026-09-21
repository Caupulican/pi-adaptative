/**
 * Canonical list of the node-test suites that guard the test harness and the release flow.
 *
 * One source of truth, imported by both the runner (`run-test-harness-isolation.mjs`) and the
 * contract test. It used to be a literal string duplicated between `package.json` and the contract
 * test, so legitimately adding a suite failed as a string mismatch that named neither the suite
 * nor the reason.
 */

/** Suites without which the gate no longer guards what it is named for. */
export const REQUIRED_TEST_HARNESS_ISOLATION_TESTS = Object.freeze([
	"scripts/test-harness-isolation.test.mjs",
	"scripts/release-staging.test.mjs",
	"scripts/release-ci-proof.test.mjs",
]);

/** Every suite the gate runs, required ones first. */
export const TEST_HARNESS_ISOLATION_TESTS = Object.freeze([
	...REQUIRED_TEST_HARNESS_ISOLATION_TESTS,
	"scripts/release-adoption.test.mjs",
	"scripts/release-adoption-execution.test.mjs",
	"scripts/workspace-test-plan.test.mjs",
	"scripts/ci-affected.test.mjs",
	"scripts/ci-workflow-performance.test.mjs",
]);

/** The one npm script body that may invoke this gate. */
export const TEST_HARNESS_ISOLATION_COMMAND = "node scripts/run-test-harness-isolation.mjs";

/**
 * Validates the canonical list itself, so a malformed entry fails where it was introduced rather
 * than as a missing-file error inside `node --test`.
 */
export function assertTestHarnessContract(tests = TEST_HARNESS_ISOLATION_TESTS) {
	const problems = [];
	if (tests.length === 0) {
		problems.push("the canonical harness test list is empty");
	}
	for (const entry of tests) {
		if (typeof entry !== "string" || entry.trim() !== entry || entry.length === 0) {
			problems.push(`malformed harness test entry: ${JSON.stringify(entry)}`);
			continue;
		}
		if (!entry.startsWith("scripts/") || !entry.endsWith(".test.mjs")) {
			problems.push(`harness test entry must be a scripts/*.test.mjs path, got '${entry}'`);
		}
	}
	const duplicates = tests.filter((entry, index) => tests.indexOf(entry) !== index);
	if (duplicates.length > 0) {
		problems.push(`duplicate harness test entries: ${[...new Set(duplicates)].join(", ")}`);
	}
	const missing = REQUIRED_TEST_HARNESS_ISOLATION_TESTS.filter((entry) => !tests.includes(entry));
	if (missing.length > 0) {
		problems.push(`required harness test(s) missing from the canonical list: ${missing.join(", ")}`);
	}
	if (problems.length > 0) {
		throw new Error(`Invalid test-harness isolation contract:\n  - ${problems.join("\n  - ")}`);
	}
	return tests;
}

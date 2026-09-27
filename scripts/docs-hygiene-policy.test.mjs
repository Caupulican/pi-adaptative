import assert from "node:assert/strict";
import test from "node:test";
import { transientDocReason } from "./docs-hygiene-policy.mjs";

test("transient audit, session, plan, and generated lab artifacts are rejected from docs", () => {
	for (const path of [
		"docs/release-audit/system-interaction-ledger.md",
		"docs/release-audit/abc-architecture-audit.json",
		"docs/superpowers/plans/work.md",
		"docs/design/session-01-example.md",
		"docs/design/provider-remediation-plan.md",
		"docs/design/review-2026-09-26.md",
		"docs/design/matrix-tui-lab.html",
		"docs/project-instruction-isolation-audit-2026-08-26.md",
	]) {
		assert.equal(typeof transientDocReason(path), "string", path);
	}
});

test("current durable architecture, doctrine, ownership, and lifecycle docs remain allowed", () => {
	for (const path of [
		"docs/architecture.md",
		"docs/doctrine.md",
		"docs/objective-execution-current-ownership.md",
		"docs/design/tui-work-lifecycle.md",
	]) {
		assert.equal(transientDocReason(path), undefined, path);
	}
});

test("Windows separators cannot bypass the transient-doc policy", () => {
	assert.equal(typeof transientDocReason("docs\\release-audit\\report.json"), "string");
});

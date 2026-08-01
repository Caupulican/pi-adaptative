import { describe, expect, it } from "vitest";
import { createShellOutputProjector, isProjectableTestCommand } from "../src/core/tools/shell-output-projection.ts";

function appendInChunks(projector: NonNullable<ReturnType<typeof createShellOutputProjector>>, output: string): void {
	const bytes = Buffer.from(output, "utf-8");
	for (let offset = 0; offset < bytes.length; offset += 7) {
		projector.append(bytes.subarray(offset, offset + 7));
	}
}

describe("shell output projection", () => {
	it.each([
		"node ../../node_modules/vitest/dist/cli.js --run test/one.test.ts",
		"npx vitest --run test/one.test.ts",
		"npm run test:unit -- --runInBand",
		"node --test",
		"deno test tests/one_test.ts",
		"pnpm vitest --run test/one.test.ts",
		"uv run pytest tests/test_one.py",
		"make test",
		"python -m pytest tests/test_one.py",
		"cargo test focused_case",
		String.raw`.\BuildVersion.Tests.ps1`,
		String.raw`D:\scripts\hb\run-tests.cmd > result.txt 2>&1`,
		"./test.sh",
	])("recognizes a focused test invocation: %s", (command) => {
		expect(isProjectableTestCommand(command)).toBe(true);
	});

	it.each([
		"echo test",
		"test -f package.json",
		"npm run build",
		"rg test packages/coding-agent",
		"npm test && echo cleanup-complete",
		"cat test-results.txt",
	])("does not claim unrelated or mixed commands: %s", (command) => {
		expect(isProjectableTestCommand(command)).toBe(false);
	});

	it("collapses passing test chatter but retains the result summary", () => {
		const projector = createShellOutputProjector("npx vitest --run test/one.test.ts");
		expect(projector).toBeDefined();
		const passingLines = Array.from(
			{ length: 120 },
			(_, index) => `\u001b[32m✓\u001b[0m test/example.test.ts > case ${index}`,
		).join("\n");
		appendInChunks(
			projector!,
			`RUN v3.2.4\n${passingLines}\nTest Files  1 passed (1)\nTests  120 passed (120)\nDuration  812ms\n`,
		);

		const projection = projector!.finish(0);

		expect(projection).toBeDefined();
		expect(projection?.content).toContain("Test Files  1 passed (1)");
		expect(projection?.content).toContain("Tests  120 passed (120)");
		expect(projection?.content).not.toContain("case 42");
		expect(projection?.content).not.toContain("\u001b[");
		expect(projection?.collapsedPassingLines).toBe(120);
		expect(projection?.outputBytes).toBeLessThan(projection?.inputBytes ?? 0);
	});

	it("retains failure identity and nearby diagnostics while removing unrelated passes", () => {
		const projector = createShellOutputProjector(String.raw`.\BuildVersion.Tests.ps1`);
		expect(projector).toBeDefined();
		const passingLines = Array.from({ length: 80 }, (_, index) => `[PASS] unrelated case ${index}`).join("\n");
		appendInChunks(
			projector!,
			`${passingLines}\n[FAIL] preserves version metadata\nAssertionError: expected 4.2.0 but received 4.1.9\n  at BuildVersion.Tests.ps1:42\nTests Passed: 80, Failed: 1, Skipped: 0\n`,
		);

		const projection = projector!.finish(1);

		expect(projection).toBeDefined();
		expect(projection?.content).toContain("[FAIL] preserves version metadata");
		expect(projection?.content).toContain("AssertionError: expected 4.2.0 but received 4.1.9");
		expect(projection?.content).toContain("BuildVersion.Tests.ps1:42");
		expect(projection?.content).toContain("Tests Passed: 80, Failed: 1, Skipped: 0");
		expect(projection?.content).not.toContain("unrelated case 42");
	});

	it.each([
		{
			name: "pytest",
			command: "pytest tests/test_one.py",
			marker: "FAILED tests/test_one.py::test_bad - ValueError: boom",
			detail: "E   ValueError: boom",
		},
		{
			name: "go test",
			command: "go test ./pkg/...",
			marker: "--- FAIL: TestBad (0.00s)",
			detail: "bad_test.go:42: values differ",
		},
		{
			name: "cargo test",
			command: "cargo test focused_case",
			marker: "thread 'focused_case' panicked at src/lib.rs:42:5:",
			detail: "assertion `left == right` failed",
		},
	])("retains $name failure headers even when the final summary is far away", ({ command, marker, detail }) => {
		const projector = createShellOutputProjector(command);
		expect(projector).toBeDefined();
		const passes = Array.from({ length: 40 }, (_, index) => `✓ passing case ${index}`).join("\n");
		const trailingNoise = Array.from({ length: 30 }, (_, index) => `cleanup diagnostic ${index}`).join("\n");
		appendInChunks(
			projector!,
			`${passes}\n${marker}\n${detail}\n${trailingNoise}\nTests: 1 failed, 40 passed, 41 total\n`,
		);

		const projection = projector!.finish(1);

		expect(projection).toBeDefined();
		expect(projection?.content).toContain(marker);
		expect(projection?.content).toContain(detail);
	});

	it("falls back to raw output for an unrecognized nonzero result", () => {
		const projector = createShellOutputProjector("./test.sh");
		expect(projector).toBeDefined();
		appendInChunks(projector!, `${"opaque protocol row\n".repeat(100)}terminal marker 7391\n`);

		expect(projector!.finish(7)).toBeUndefined();
	});

	it("does not filter small output", () => {
		const projector = createShellOutputProjector("npm test");
		expect(projector).toBeDefined();
		appendInChunks(projector!, "Tests  1 passed (1)\n");

		expect(projector!.finish(0)).toBeUndefined();
	});

	it("keeps a huge unterminated diagnostic line bounded", () => {
		const projector = createShellOutputProjector("pytest tests/test_one.py");
		expect(projector).toBeDefined();
		projector!.append(Buffer.from(`AssertionError: ${"x".repeat(2 * 1024 * 1024)}`, "utf-8"));

		const projection = projector!.finish(1);

		expect(projection).toBeDefined();
		expect(projection?.content).toContain("AssertionError");
		expect(projection?.content.length).toBeLessThan(20 * 1024);
		expect(projection?.inputBytes).toBeGreaterThan(2 * 1024 * 1024);
	});
});

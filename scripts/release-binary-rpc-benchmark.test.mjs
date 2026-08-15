import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { requireFlagValue } from "./flag-value-args.mjs";
import { runReleaseBinaryRpcBenchmark } from "./release-binary-rpc-benchmark.mjs";

function writeFixture(directory, name, source) {
	const fixturePath = join(directory, name);
	writeFileSync(fixturePath, source);
	chmodSync(fixturePath, 0o755);
	return fixturePath;
}

test("requires an explicit value after a release-script flag", () => {
	assert.equal(requireFlagValue(["--output", "result.json"], 0), "result.json");
	assert.throws(() => requireFlagValue(["--output", "--samples", "5"], 0), /--output requires a value/u);
});

test("benchmarks cold startup plus cold and warm RPC shell latency", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-release-binary-benchmark-"));
	try {
		const fixturePath = writeFixture(
			directory,
			"responsive-rpc.mjs",
			`let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	pending += chunk;
	let newline = pending.indexOf("\\n");
	while (newline !== -1) {
		const line = pending.slice(0, newline);
		pending = pending.slice(newline + 1);
		const request = JSON.parse(line);
		const response = request.type === "get_state"
			? { type: "response", id: request.id, command: "get_state", success: true, data: {} }
			: { type: "response", id: request.id, command: "bash", success: true, data: { exitCode: 0, output: "benchmark-ok\\n" } };
		process.stdout.write(JSON.stringify(response) + "\\n");
		newline = pending.indexOf("\\n");
	}
});
`,
		);

		const result = await runReleaseBinaryRpcBenchmark({
			executable: process.execPath,
			executableArgs: [fixturePath],
			samples: 2,
			warmIterations: 2,
			warmupSamples: 1,
			requestTimeoutMs: 2_000,
		});

		assert.equal(result.samples, 2);
		assert.equal(result.warmIterations, 2);
		assert.equal(result.metrics.coldRpc.samples.length, 2);
		assert.equal(result.metrics.coldShell.samples.length, 2);
		assert.equal(result.metrics.firstShellReady.samples.length, 2);
		assert.equal(result.metrics.warmRpc.samples.length, 4);
		assert.equal(result.metrics.warmShell.samples.length, 4);
		for (const metric of Object.values(result.metrics)) {
			assert.ok(metric.medianMs >= 0);
			assert.ok(metric.p95Ms >= metric.medianMs);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("rejects a process that exits before its RPC response", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-release-binary-benchmark-failure-"));
	try {
		const fixturePath = writeFixture(directory, "silent-exit.mjs", "process.exit(0);\n");
		await assert.rejects(
			runReleaseBinaryRpcBenchmark({
				executable: process.execPath,
				executableArgs: [fixturePath],
				samples: 1,
				warmIterations: 1,
				warmupSamples: 0,
				requestTimeoutMs: 2_000,
			}),
			/closed before RPC response/u,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

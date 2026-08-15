import assert from "node:assert/strict";
import test from "node:test";
import { evaluateReleaseBinaryPerformance } from "./release-binary-performance-gate.mjs";

function metric(medianMs, p95Ms = medianMs) {
	return { samples: [medianMs], minMs: medianMs, medianMs, p95Ms, maxMs: p95Ms };
}

function benchmark(label, metrics) {
	return {
		schemaVersion: 2,
		label,
		platform: label.startsWith("linux") ? "linux" : "win32",
		architecture: label.endsWith("arm64") ? "arm64" : "x64",
		samples: 5,
		warmIterations: 10,
		metrics: {
			coldRpc: metric(800, 900),
			coldShell: metric(10, 15),
			firstShellReady: metric(810, 915),
			warmRpc: metric(0.5, 1),
			warmShell: metric(2, 4),
			...metrics,
		},
	};
}

test("accepts native Windows binaries that reach the first shell near Linux speed", () => {
	const linux = benchmark("linux-x64", {});
	const windows = [
		benchmark("windows-x64", {
			coldRpc: metric(1_100, 1_300),
			coldShell: metric(20, 40),
			firstShellReady: metric(1_120, 1_340),
		}),
		benchmark("windows-arm64", {
			coldRpc: metric(1_000, 1_200),
			coldShell: metric(25, 50),
			firstShellReady: metric(1_025, 1_250),
		}),
	];

	const report = evaluateReleaseBinaryPerformance({ linux, windows });

	assert.equal(report.passed, true);
	assert.equal(report.platforms.length, 2);
	assert.ok(report.platforms.every((platform) => platform.checks.every((check) => check.passed)));
});

test("rejects the confirmed disposable-probe cold-shell regression", () => {
	const linux = benchmark("linux-x64", {});
	const windows = [
		benchmark("windows-x64", {
			coldShell: metric(700, 900),
			firstShellReady: metric(1_500, 1_800),
		}),
	];

	const report = evaluateReleaseBinaryPerformance({ linux, windows });

	assert.equal(report.passed, false);
	assert.deepEqual(
		report.platforms[0].checks.filter((check) => !check.passed).map((check) => check.name),
		["coldShell.medianMs", "coldShell.p95Ms", "firstShellReady.medianRatio"],
	);
});

test("rejects a Windows slowdown even when the Linux comparison is also slow", () => {
	const linux = benchmark("linux-x64", {
		firstShellReady: metric(2_000, 2_500),
	});
	const windows = [
		benchmark("windows-arm64", {
			firstShellReady: metric(2_100, 2_700),
		}),
	];

	const report = evaluateReleaseBinaryPerformance({ linux, windows });

	assert.equal(report.passed, false);
	assert.deepEqual(
		report.platforms[0].checks.filter((check) => !check.passed).map((check) => check.name),
		["firstShellReady.medianMs"],
	);
});

test("reports Linux-relative runner variance without blocking acceptable absolute Windows latency", () => {
	const linux = benchmark("linux-x64", {
		firstShellReady: metric(666, 677),
	});
	const windows = [
		benchmark("windows-x64", {
			coldShell: metric(56, 59),
			firstShellReady: metric(1_621, 1_642),
			warmRpc: metric(0.48, 0.58),
			warmShell: metric(1.94, 3.26),
		}),
	];

	const report = evaluateReleaseBinaryPerformance({ linux, windows });
	const medianRatio = report.platforms[0].checks.find(
		(check) => check.name === "firstShellReady.medianRatio",
	);

	assert.equal(report.schemaVersion, 2);
	assert.equal(report.passed, true);
	assert.equal(report.platforms[0].passed, true);
	assert.equal(medianRatio?.passed, false);
	assert.equal(medianRatio?.blocking, false);
});

test("requires paired first-shell metrics from one Linux and at least one Windows benchmark", () => {
	assert.throws(
		() => evaluateReleaseBinaryPerformance({ linux: benchmark("linux-x64", { firstShellReady: undefined }), windows: [] }),
		/firstShellReady/u,
	);
});

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
	NeedleDetectResult,
	NeedleFunctionCallRequest,
	NeedleFunctionCallResult,
	NeedleRuntime,
	NeedleSmokeTestResult,
	NeedleWeightsDownloadResult,
} from "../src/core/models/needle-runtime.ts";
import {
	addNeedleModel,
	handleModelsCommand,
	type LocalModelHost,
} from "../src/modes/interactive/local-model-commands.ts";

/**
 * Orchestration tests for the needle wiring: addNeedleModel's pipeline call-order and stage-failure
 * handling, the /models needle query subcommand, and /models remove for needle — against a fake
 * runtime implementing NeedleRuntime's public surface. The runtime's internal mechanics (clone/venv
 * install, sha256-pinned download, stdout parsing) are covered by needle-runtime.test.ts and
 * deliberately not re-tested here.
 */

interface FakeNeedleRuntimeScript {
	detect?: () => Promise<NeedleDetectResult>;
	installManaged?: () => Promise<{ ok: boolean; error?: string }>;
	downloadWeights?: () => Promise<NeedleWeightsDownloadResult>;
	smokeTest?: () => Promise<NeedleSmokeTestResult>;
	runFunctionCall?: (request: NeedleFunctionCallRequest) => Promise<NeedleFunctionCallResult>;
	runtimeDir?: string;
	modelsDir?: string;
	checkpointPath?: string;
}

function fakeNeedleRuntime(script: FakeNeedleRuntimeScript, calls: string[]): NeedleRuntime {
	const runtime = {
		detect: vi.fn(async () => {
			calls.push("detect");
			return (
				script.detect ?? (async () => ({ installed: true, pythonAvailable: true, checkpointPresent: true }))
			)();
		}),
		installManaged: vi.fn(async (onProgress?: (status: string) => void) => {
			calls.push("installManaged");
			onProgress?.("installing…");
			return (script.installManaged ?? (async () => ({ ok: true })))();
		}),
		downloadWeights: vi.fn(async (onProgress?: (status: string) => void) => {
			calls.push("downloadWeights");
			onProgress?.("downloading…");
			return (script.downloadWeights ?? (async () => ({ ok: true, path: "/models/needle/needle.pkl" })))();
		}),
		smokeTest: vi.fn(async () => {
			calls.push("smokeTest");
			return (
				script.smokeTest ??
				(async () => ({ ok: true, latencyMs: 10, call: { name: "get_weather", arguments: { location: "SF" } } }))
			)();
		}),
		runFunctionCall: vi.fn(async (request: NeedleFunctionCallRequest) => {
			calls.push(`runFunctionCall:${request.query}`);
			return (
				script.runFunctionCall ??
				(async () => ({ ok: true, call: { name: "get_weather", arguments: { location: "SF" } } }))
			)(request);
		}),
		runtimeDir: vi.fn(() => script.runtimeDir ?? "/runtimes/needle"),
		modelsDir: vi.fn(() => script.modelsDir ?? "/models/needle"),
		checkpointPath: vi.fn(() => script.checkpointPath ?? "/models/needle/needle.pkl"),
		dispose: vi.fn(),
	};
	return runtime as unknown as NeedleRuntime;
}

function fakeHost(runtime: NeedleRuntime): { host: LocalModelHost; statuses: string[] } {
	const statuses: string[] = [];
	const host = {
		getNeedleRuntime: () => runtime,
		showStatus: (text: string) => statuses.push(text),
		showError: (text: string) => statuses.push(`ERROR: ${text}`),
	} as unknown as LocalModelHost;
	return { host, statuses };
}

describe("addNeedleModel", () => {
	it("happy path: already installed -> download -> smoke test, in order, with a success summary", async () => {
		const calls: string[] = [];
		const runtime = fakeNeedleRuntime({}, calls);
		const { host, statuses } = fakeHost(runtime);

		await addNeedleModel(host);

		expect(calls).toEqual(["detect", "downloadWeights", "smokeTest"]);
		expect(calls).not.toContain("installManaged");
		expect(statuses.some((line) => line.includes("installed and verified"))).toBe(true);
		expect(statuses.some((line) => line.includes("get_weather"))).toBe(true);
		expect(statuses.some((line) => line.includes("standalone bench, not a chat/executor lane"))).toBe(true);
	});

	it("installs on consent when not already installed, then continues in order", async () => {
		const calls: string[] = [];
		let detectCount = 0;
		const runtime = fakeNeedleRuntime(
			{
				detect: async () => {
					detectCount++;
					return { installed: detectCount > 1, pythonAvailable: true, checkpointPresent: false };
				},
			},
			calls,
		);
		const { host } = fakeHost(runtime);

		await addNeedleModel(host);

		expect(calls).toEqual(["detect", "installManaged", "detect", "downloadWeights", "smokeTest"]);
	});

	it("stage failure: install fails -> stops before download, surfaces the error", async () => {
		const calls: string[] = [];
		const runtime = fakeNeedleRuntime(
			{
				detect: async () => ({ installed: false, pythonAvailable: true, checkpointPresent: false }),
				installManaged: async () => ({ ok: false, error: "python-missing: python3 (>=3.11) is required" }),
			},
			calls,
		);
		const { host, statuses } = fakeHost(runtime);

		await addNeedleModel(host);

		expect(calls).toEqual(["detect", "installManaged"]);
		expect(statuses.some((line) => line.includes("needle install failed") && line.includes("python-missing"))).toBe(
			true,
		);
	});

	it("stage failure: weights download fails -> stops before the smoke test", async () => {
		const calls: string[] = [];
		const runtime = fakeNeedleRuntime(
			{ downloadWeights: async () => ({ ok: false, error: "integrity-fail: sha256 mismatch" }) },
			calls,
		);
		const { host, statuses } = fakeHost(runtime);

		await addNeedleModel(host);

		expect(calls).toEqual(["detect", "downloadWeights"]);
		expect(
			statuses.some((line) => line.includes("needle weights download failed") && line.includes("integrity-fail")),
		).toBe(true);
	});

	it("stage failure: smoke test fails -> never claims success", async () => {
		const calls: string[] = [];
		const runtime = fakeNeedleRuntime(
			{ smokeTest: async () => ({ ok: false, latencyMs: 5, error: "run-fail: Traceback OOM killed" }) },
			calls,
		);
		const { host, statuses } = fakeHost(runtime);

		await addNeedleModel(host);

		expect(calls).toEqual(["detect", "downloadWeights", "smokeTest"]);
		expect(statuses.some((line) => line.includes("needle smoke test failed") && line.includes("OOM killed"))).toBe(
			true,
		);
		expect(statuses.some((line) => line.includes("installed and verified"))).toBe(false);
	});

	it("defensive: a smoke test reporting ok with no parsed call is treated as a failure, never fabricated", async () => {
		const calls: string[] = [];
		const runtime = fakeNeedleRuntime({ smokeTest: async () => ({ ok: true, latencyMs: 5 }) }, calls);
		const { host, statuses } = fakeHost(runtime);

		await addNeedleModel(host);

		expect(statuses.some((line) => line.includes("needle smoke test failed"))).toBe(true);
		expect(statuses.some((line) => line.includes("installed and verified"))).toBe(false);
	});
});

describe("/models needle <query> [tools-json] subcommand", () => {
	it("usage message when no query is given", async () => {
		const calls: string[] = [];
		const runtime = fakeNeedleRuntime({}, calls);
		const { host, statuses } = fakeHost(runtime);

		await handleModelsCommand(host, "needle");

		expect(calls).toEqual([]);
		expect(statuses.some((line) => line.includes("Usage: /models needle"))).toBe(true);
	});

	it("refuses cleanly with install guidance when not installed — never spawns a doomed process", async () => {
		const calls: string[] = [];
		const runtime = fakeNeedleRuntime(
			{ detect: async () => ({ installed: false, pythonAvailable: true, checkpointPresent: false }) },
			calls,
		);
		const { host, statuses } = fakeHost(runtime);

		await handleModelsCommand(host, "needle What's the weather?");

		expect(calls).toEqual(["detect"]);
		expect(statuses.some((line) => line.includes("needle is not installed"))).toBe(true);
		expect(statuses.some((line) => line.includes("/models add hf.co/Cactus-Compute/needle"))).toBe(true);
	});

	it("refuses cleanly with install guidance when installed but the checkpoint is missing", async () => {
		const calls: string[] = [];
		const runtime = fakeNeedleRuntime(
			{ detect: async () => ({ installed: true, pythonAvailable: true, checkpointPresent: false }) },
			calls,
		);
		const { host, statuses } = fakeHost(runtime);

		await handleModelsCommand(host, "needle What's the weather?");

		expect(calls).toEqual(["detect"]);
		expect(statuses.some((line) => line.includes("checkpoint hasn't been downloaded"))).toBe(true);
	});

	it("happy path: default tools when no tools-json is given, query reassembled from split tokens", async () => {
		const calls: string[] = [];
		let capturedRequest: NeedleFunctionCallRequest | undefined;
		const runtime = fakeNeedleRuntime(
			{
				runFunctionCall: async (request) => {
					capturedRequest = request;
					return { ok: true, call: { name: "get_weather", arguments: { location: "Tokyo" } } };
				},
			},
			calls,
		);
		const { host, statuses } = fakeHost(runtime);

		await handleModelsCommand(host, "needle What's the weather in Tokyo");

		expect(calls).toEqual(["detect", "runFunctionCall:What's the weather in Tokyo"]);
		expect(capturedRequest?.query).toBe("What's the weather in Tokyo");
		expect(capturedRequest?.tools).toEqual([
			{
				name: "get_weather",
				description: "Get current weather for a city.",
				parameters: { location: { type: "string", description: "City name.", required: true } },
			},
		]);
		expect(statuses.some((line) => line.includes("get_weather"))).toBe(true);
	});

	it("a trailing compact-JSON token is parsed as tools-json and stripped from the query", async () => {
		const calls: string[] = [];
		let capturedRequest: NeedleFunctionCallRequest | undefined;
		const runtime = fakeNeedleRuntime(
			{
				runFunctionCall: async (request) => {
					capturedRequest = request;
					return { ok: true, call: { name: "toggle_lights", arguments: { room: "kitchen" } } };
				},
			},
			calls,
		);
		const { host } = fakeHost(runtime);
		const toolsJson = JSON.stringify([{ name: "toggle_lights", description: "d", parameters: {} }]);

		await handleModelsCommand(host, `needle Turn off the kitchen lights ${toolsJson}`);

		expect(capturedRequest?.query).toBe("Turn off the kitchen lights");
		expect(capturedRequest?.tools).toEqual([{ name: "toggle_lights", description: "d", parameters: {} }]);
	});

	it("strict-parse failure: prints the parsed error and raw output, never a guessed result", async () => {
		const calls: string[] = [];
		const runtime = fakeNeedleRuntime(
			{
				runFunctionCall: async () => ({
					ok: false,
					error: "unparseable-output: no <tool_call> marker in stdout",
					rawOutput: "Loading checkpoint: x\nModel parameters: 1\n",
				}),
			},
			calls,
		);
		const { host, statuses } = fakeHost(runtime);

		await handleModelsCommand(host, "needle some ambiguous query");

		expect(statuses.some((line) => line.includes("unparseable-output"))).toBe(true);
		expect(statuses.some((line) => line.includes("Loading checkpoint: x"))).toBe(true);
	});
});

describe("/models remove for needle", () => {
	it("full disclosure without deleting anything when not confirmed", async () => {
		const runtimeDir = mkdtempSync(join(tmpdir(), "pi-needle-remove-runtime-"));
		const modelsDir = mkdtempSync(join(tmpdir(), "pi-needle-remove-models-"));
		try {
			const calls: string[] = [];
			const runtime = fakeNeedleRuntime({ runtimeDir, modelsDir }, calls);
			const { host, statuses } = fakeHost(runtime);

			await handleModelsCommand(host, "remove hf.co/Cactus-Compute/needle");

			expect(statuses.some((line) => line.includes("Removing needle will delete"))).toBe(true);
			expect(statuses.some((line) => line.includes("no models.json entry or fitness report"))).toBe(true);
			expect(existsSync(runtimeDir)).toBe(true);
			expect(existsSync(modelsDir)).toBe(true);
		} finally {
			rmSync(runtimeDir, { recursive: true, force: true });
			rmSync(modelsDir, { recursive: true, force: true });
		}
	});

	it("confirmed: actually deletes the runtime and weights directories", async () => {
		const runtimeDir = mkdtempSync(join(tmpdir(), "pi-needle-remove-runtime-"));
		const modelsDir = mkdtempSync(join(tmpdir(), "pi-needle-remove-models-"));
		mkdirSync(join(runtimeDir, "venv", "bin"), { recursive: true });
		writeFileSync(join(runtimeDir, "venv", "bin", "needle"), "#!/bin/sh\n");
		mkdirSync(modelsDir, { recursive: true });
		writeFileSync(join(modelsDir, "needle.pkl"), "fake-weights");
		try {
			const calls: string[] = [];
			const runtime = fakeNeedleRuntime({ runtimeDir, modelsDir }, calls);
			const { host, statuses } = fakeHost(runtime);

			await handleModelsCommand(host, "remove hf.co/Cactus-Compute/needle confirm");

			expect(existsSync(runtimeDir)).toBe(false);
			expect(existsSync(modelsDir)).toBe(false);
			expect(statuses.some((line) => line.includes("needle removed"))).toBe(true);
		} finally {
			rmSync(runtimeDir, { recursive: true, force: true });
			rmSync(modelsDir, { recursive: true, force: true });
		}
	});
});

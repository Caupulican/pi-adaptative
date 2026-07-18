import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	BONSAI_27B,
	type PrismDetectResult,
	type PrismDownloadResult,
	type PrismLlamaCppRuntime,
	type PrismServeResult,
} from "../src/core/models/llamacpp-runtime.ts";
import { addPrismLlamaCppModel, type LocalModelHost } from "../src/modes/interactive/local-model-commands.ts";

/**
 * Orchestration tests for addPrismLlamaCppModel: the pipeline's OWN call-order and stage-failure
 * handling, against a fake runtime that implements PrismLlamaCppRuntime's public surface. The
 * runtime's internal mechanics (asset resolution, archive extraction, health polling, byte
 * verification) are covered by llamacpp-runtime.test.ts and deliberately not re-tested here.
 */

interface FakeRuntimeScript {
	detect?: () => Promise<PrismDetectResult>;
	installManaged?: () => Promise<{ ok: boolean; error?: string }>;
	downloadModel?: (args: { repo: string; file: string }) => Promise<PrismDownloadResult>;
	serve?: () => Promise<PrismServeResult>;
}

function fakeRuntime(script: FakeRuntimeScript, calls: string[]): PrismLlamaCppRuntime {
	const runtime = {
		detect: vi.fn(async () => {
			calls.push("detect");
			return (script.detect ?? (async () => ({ runtimeInstalled: true })))();
		}),
		installManaged: vi.fn(async (onProgress?: (status: string) => void) => {
			calls.push("installManaged");
			onProgress?.("installing…");
			return (script.installManaged ?? (async () => ({ ok: true })))();
		}),
		downloadModel: vi.fn(async (args: { repo: string; file: string }, onProgress?: (status: string) => void) => {
			calls.push(`downloadModel:${args.file}`);
			onProgress?.(`downloading ${args.file}…`);
			return (
				script.downloadModel ??
				(async (a: { repo: string; file: string }) => ({ ok: true, path: `/models/${a.file}` }))
			)(args);
		}),
		serve: vi.fn(async (args: { modelPath: string; mmprojPath?: string; port: number; numCtx: number }) => {
			calls.push(`serve:${args.port}:${args.numCtx}`);
			return (script.serve ?? (async () => ({ ok: true, baseUrl: "http://127.0.0.1:8090" }) as PrismServeResult))();
		}),
		stop: vi.fn(() => ({ stopped: false })),
		isRunning: vi.fn(() => false),
		runtimeDir: vi.fn(() => "/runtimes/prism-llamacpp"),
		modelsDir: vi.fn(() => "/models/llamacpp"),
	};
	return runtime as unknown as PrismLlamaCppRuntime;
}

function fakeHost(runtime: PrismLlamaCppRuntime): {
	host: LocalModelHost;
	statuses: string[];
	refreshCalled: () => boolean;
	fitnessRef: () => string | undefined;
} {
	const statuses: string[] = [];
	let refreshCalled = false;
	let fitnessRef: string | undefined;
	const host = {
		getPrismLlamaCppRuntime: () => runtime,
		showStatus: (text: string) => statuses.push(text),
		showError: (text: string) => statuses.push(`ERROR: ${text}`),
		chatContainer: { addChild: vi.fn() },
		ui: { requestRender: vi.fn() },
		showSelector: vi.fn(),
		session: {
			runModelFitness: async (args: { model: string }) => {
				fitnessRef = args.model;
				return { started: false, skipReason: "test-short-circuit" };
			},
			modelRegistry: {
				refresh: () => {
					refreshCalled = true;
				},
			},
		},
	} as unknown as LocalModelHost;
	return { host, statuses, refreshCalled: () => refreshCalled, fitnessRef: () => fitnessRef };
}

describe("addPrismLlamaCppModel", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = join(tmpdir(), `pi-prism-add-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(() => {
		delete process.env[ENV_AGENT_DIR];
		if (agentDir && existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
	});

	it("happy path: detect -> download main+mmproj -> serve -> register -> refresh -> probe, in order", async () => {
		const calls: string[] = [];
		const runtime = fakeRuntime({ detect: async () => ({ runtimeInstalled: true }) }, calls);
		const { host, statuses, refreshCalled, fitnessRef } = fakeHost(runtime);

		await addPrismLlamaCppModel(host, BONSAI_27B);

		expect(calls).toEqual([
			"detect",
			`downloadModel:${BONSAI_27B.file}`,
			`downloadModel:${BONSAI_27B.mmprojFile}`,
			expect.stringMatching(/^serve:8090:\d+$/),
		]);
		// Not installed -> installManaged is never called when detect already reports it's ready.
		expect(calls).not.toContain("installManaged");
		expect(refreshCalled()).toBe(true);
		expect(fitnessRef()).toBe(`llama-cpp/${BONSAI_27B.repo}`);

		const modelsJson = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf-8"));
		expect(modelsJson.providers["llama-cpp"].models).toEqual([
			expect.objectContaining({
				id: BONSAI_27B.repo,
				baseUrl: "http://127.0.0.1:8090/v1",
				input: ["text", "image"],
			}),
		]);
		expect(statuses.some((line) => line.includes("Probing fitness"))).toBe(true);
	});

	it("installs the runtime on consent when not already installed, then continues", async () => {
		const calls: string[] = [];
		let detectCount = 0;
		const runtime = fakeRuntime(
			{
				detect: async () => {
					detectCount++;
					return { runtimeInstalled: detectCount > 1 };
				},
			},
			calls,
		);
		const { host, refreshCalled } = fakeHost(runtime);

		await addPrismLlamaCppModel(host, BONSAI_27B);

		expect(calls).toEqual([
			"detect",
			"installManaged",
			"detect",
			`downloadModel:${BONSAI_27B.file}`,
			`downloadModel:${BONSAI_27B.mmprojFile}`,
			expect.stringMatching(/^serve:8090:\d+$/),
		]);
		expect(refreshCalled()).toBe(true);
	});

	it("stage failure: runtime install fails -> stops before any download, surfaces the error", async () => {
		const calls: string[] = [];
		const runtime = fakeRuntime(
			{
				detect: async () => ({ runtimeInstalled: false }),
				installManaged: async () => ({ ok: false, error: "download-fail: HTTP 500" }),
			},
			calls,
		);
		const { host, statuses, refreshCalled, fitnessRef } = fakeHost(runtime);

		await addPrismLlamaCppModel(host, BONSAI_27B);

		expect(calls).toEqual(["detect", "installManaged"]);
		expect(statuses.some((line) => line.includes("runtime install failed") && line.includes("HTTP 500"))).toBe(true);
		expect(refreshCalled()).toBe(false);
		expect(fitnessRef()).toBeUndefined();
		expect(existsSync(join(agentDir, "models.json"))).toBe(false);
	});

	it("stage failure: main weights download fails -> stops before mmproj download and serve", async () => {
		const calls: string[] = [];
		const runtime = fakeRuntime(
			{
				downloadModel: async (args) =>
					args.file === BONSAI_27B.file
						? { ok: false, error: "size-mismatch: expected 100 got 50" }
						: { ok: true, path: "x" },
			},
			calls,
		);
		const { host, statuses, refreshCalled } = fakeHost(runtime);

		await addPrismLlamaCppModel(host, BONSAI_27B);

		expect(calls).toEqual(["detect", `downloadModel:${BONSAI_27B.file}`]);
		expect(statuses.some((line) => line.includes("Model download failed") && line.includes("size-mismatch"))).toBe(
			true,
		);
		expect(refreshCalled()).toBe(false);
	});

	it("stage failure: mmproj download fails -> stops before serve", async () => {
		const calls: string[] = [];
		const runtime = fakeRuntime(
			{
				downloadModel: async (args) =>
					args.file === BONSAI_27B.mmprojFile
						? { ok: false, error: "download-fail: HTTP 404" }
						: { ok: true, path: `/models/${args.file}` },
			},
			calls,
		);
		const { host, statuses, refreshCalled } = fakeHost(runtime);

		await addPrismLlamaCppModel(host, BONSAI_27B);

		expect(calls).toEqual(["detect", `downloadModel:${BONSAI_27B.file}`, `downloadModel:${BONSAI_27B.mmprojFile}`]);
		expect(
			statuses.some((line) => line.includes("Vision projector download failed") && line.includes("HTTP 404")),
		).toBe(true);
		expect(refreshCalled()).toBe(false);
	});

	it("stage failure: serve fails (e.g. health-timeout) -> stops before registration", async () => {
		const calls: string[] = [];
		const runtime = fakeRuntime({ serve: async () => ({ ok: false, error: "health-timeout" }) }, calls);
		const { host, statuses, refreshCalled, fitnessRef } = fakeHost(runtime);

		await addPrismLlamaCppModel(host, BONSAI_27B);

		expect(calls[calls.length - 1]).toMatch(/^serve:8090:\d+$/);
		expect(
			statuses.some((line) => line.includes("Could not start llama-server") && line.includes("health-timeout")),
		).toBe(true);
		expect(refreshCalled()).toBe(false);
		expect(fitnessRef()).toBeUndefined();
		expect(existsSync(join(agentDir, "models.json"))).toBe(false);
	});

	it("skipped download path: an already-downloaded file (skipped: true) still carries a usable path through to serve", async () => {
		const calls: string[] = [];
		const runtime = fakeRuntime(
			{
				downloadModel: async (args) => ({ ok: true, path: `/models/${args.file}`, skipped: true }),
			},
			calls,
		);
		const { host, refreshCalled } = fakeHost(runtime);

		await addPrismLlamaCppModel(host, BONSAI_27B);

		expect(calls).toEqual([
			"detect",
			`downloadModel:${BONSAI_27B.file}`,
			`downloadModel:${BONSAI_27B.mmprojFile}`,
			expect.stringMatching(/^serve:8090:\d+$/),
		]);
		expect(refreshCalled()).toBe(true);
	});
});

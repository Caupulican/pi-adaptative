import { describe, expect, it, vi } from "vitest";
import {
	BONSAI_27B,
	type PrismDetectResult,
	type PrismDownloadResult,
	type PrismLlamaCppRuntime,
	type PrismServeResult,
} from "../src/core/models/llamacpp-runtime.ts";
import {
	derivePrismLlamaCppNumCtx,
	ensurePrismModelFilesThenServe,
	isPiManagedPrismLlamaCppModel,
	isPrismLlamaCppServerHealthy,
	PRISM_LLAMACPP_DESCRIPTORS,
} from "../src/core/models/prism-llamacpp-lifecycle.ts";

/**
 * Orchestration tests for the shared prism llama.cpp lifecycle primitives: the pipeline/gate's OWN
 * call-order and stage-failure handling, against a fake runtime that implements
 * PrismLlamaCppRuntime's public surface. The runtime's internal mechanics (asset resolution,
 * archive extraction, health polling, byte verification) are covered by llamacpp-runtime.test.ts
 * and deliberately not re-tested here.
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

describe("derivePrismLlamaCppNumCtx", () => {
	it("mirrors context-sizing.ts's rung table, hard-capped at 32768 regardless of headroom", () => {
		expect(derivePrismLlamaCppNumCtx(128e9)).toBe(32_768);
		expect(derivePrismLlamaCppNumCtx(64e9)).toBe(32_768);
		expect(derivePrismLlamaCppNumCtx(40e9)).toBe(16_384);
		expect(derivePrismLlamaCppNumCtx(32e9)).toBe(16_384);
		expect(derivePrismLlamaCppNumCtx(20e9)).toBe(8_192);
		expect(derivePrismLlamaCppNumCtx(16e9)).toBe(8_192);
		expect(derivePrismLlamaCppNumCtx(8e9)).toBe(4_096);
	});
});

describe("isPiManagedPrismLlamaCppModel", () => {
	it("is true for the curated Bonsai-27B id under the llama-cpp provider", () => {
		expect(isPiManagedPrismLlamaCppModel({ provider: "llama-cpp", id: BONSAI_27B.repo })).toBe(true);
	});

	it("is false for the built-in llama-cpp/local catalog entry — never gates a user's own server", () => {
		expect(isPiManagedPrismLlamaCppModel({ provider: "llama-cpp", id: "local" })).toBe(false);
	});

	it("is false for any other user-configured llama-cpp model id", () => {
		expect(isPiManagedPrismLlamaCppModel({ provider: "llama-cpp", id: "my-own-model" })).toBe(false);
	});

	it("is false for a curated id under a different provider", () => {
		expect(isPiManagedPrismLlamaCppModel({ provider: "ollama", id: BONSAI_27B.repo })).toBe(false);
	});

	it("PRISM_LLAMACPP_DESCRIPTORS carries the Bonsai-27B descriptor at its own repo key", () => {
		expect(PRISM_LLAMACPP_DESCRIPTORS[BONSAI_27B.repo]).toEqual(BONSAI_27B);
	});
});

describe("isPrismLlamaCppServerHealthy", () => {
	it("is true on a 200 response from <serverUrl>/health", async () => {
		const urls: string[] = [];
		const fetchFn = (async (url: string) => {
			urls.push(String(url));
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		expect(await isPrismLlamaCppServerHealthy("http://127.0.0.1:8090", fetchFn)).toBe(true);
		expect(urls).toEqual(["http://127.0.0.1:8090/health"]);
	});

	it("is false on a non-ok response", async () => {
		const fetchFn = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
		expect(await isPrismLlamaCppServerHealthy("http://127.0.0.1:8090", fetchFn)).toBe(false);
	});

	it("is false when the request throws (connection refused, etc.)", async () => {
		const fetchFn = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		expect(await isPrismLlamaCppServerHealthy("http://127.0.0.1:8090", fetchFn)).toBe(false);
	});
});

describe("ensurePrismModelFilesThenServe (self-heal invariant: no serve without both GGUF files)", () => {
	it("a missing mmproj file is re-downloaded (not skipped) and llama-server still starts with it", async () => {
		const calls: string[] = [];
		// downloadModel does not tell the caller whether a file was present or missing on disk —
		// that is llamacpp-runtime.ts's own idempotent-download concern (see downloadModel's own
		// tests in llamacpp-runtime.test.ts). What THIS function must guarantee is that it always
		// calls downloadModel for the mmproj file before serving, so a missing file is transparently
		// re-fetched (skipped: false here stands in for "the file was not already on disk").
		const runtime = fakeRuntime(
			{
				downloadModel: async (args) => ({
					ok: true,
					path: `/models/${args.file}`,
					skipped: args.file !== BONSAI_27B.mmprojFile,
				}),
			},
			calls,
		);

		const result = await ensurePrismModelFilesThenServe(runtime, BONSAI_27B, { port: 8090, numCtx: 8192 }, () => {});

		expect(calls).toEqual([
			`downloadModel:${BONSAI_27B.file}`,
			`downloadModel:${BONSAI_27B.mmprojFile}`,
			"serve:8090:8192",
		]);
		expect(result).toEqual({ ok: true, baseUrl: "http://127.0.0.1:8090" });
	});

	it("mmproj re-download failure surfaces the download error and NEVER spawns llama-server", async () => {
		const calls: string[] = [];
		const runtime = fakeRuntime(
			{
				downloadModel: async (args) =>
					args.file === BONSAI_27B.mmprojFile
						? { ok: false, error: "download-fail: HTTP 503" }
						: { ok: true, path: `/models/${args.file}` },
			},
			calls,
		);

		const result = await ensurePrismModelFilesThenServe(runtime, BONSAI_27B, { port: 8090, numCtx: 8192 }, () => {});

		expect(result).toEqual({ ok: false, stage: "mmproj-download", error: "download-fail: HTTP 503" });
		expect(calls).toEqual([`downloadModel:${BONSAI_27B.file}`, `downloadModel:${BONSAI_27B.mmprojFile}`]);
		expect(calls.some((call) => call.startsWith("serve:"))).toBe(false);
	});

	it("main-weights re-download failure also never spawns llama-server", async () => {
		const calls: string[] = [];
		const runtime = fakeRuntime(
			{
				downloadModel: async (args) =>
					args.file === BONSAI_27B.file
						? { ok: false, error: "size-mismatch: expected 100 got 50" }
						: { ok: true, path: `/models/${args.file}` },
			},
			calls,
		);

		const result = await ensurePrismModelFilesThenServe(runtime, BONSAI_27B, { port: 8090, numCtx: 8192 }, () => {});

		expect(result).toEqual({ ok: false, stage: "model-download", error: "size-mismatch: expected 100 got 50" });
		expect(calls).toEqual([`downloadModel:${BONSAI_27B.file}`]);
		expect(calls.some((call) => call.startsWith("serve:"))).toBe(false);
	});
});

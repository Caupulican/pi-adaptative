import type { Model } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { LocalRuntimeController } from "../src/core/local-runtime-controller.ts";
import type { LocalRuntimeDeps } from "../src/core/models/local-runtime.ts";
import { OllamaRuntime } from "../src/core/models/local-runtime.ts";
import { createHarness } from "./suite/harness.ts";

/**
 * End-to-end: AgentSession now wires `reconcileLocalRuntimes` (the real
 * `_localRuntimeController.reconcile(this._collectEligibleLocalModelsForReconcile())` call) into the
 * RuntimeBuilder reload path. This drives a REAL `session.reload()` — not a stubbed hook — and
 * proves a local (Ollama) model that isn't the foreground model and isn't any configured router
 * tier gets its pi-spawned runtime stopped, exactly the "dropped from the live configuration"
 * scenario this test exists for. See test/runtime-builder-reload-reconcile.test.ts for the lower-level
 * (stubbed-hook) timing contract, and test/local-runtime-controller-reconcile.test.ts for
 * LocalRuntimeController.reconcile's own unit coverage.
 */

type Api = string;

function localModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider: "ollama",
		id: "qwen3:0.6b",
		name: "qwen3:0.6b",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:11434/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 2_048,
		...overrides,
	} as Model<Api>;
}

function configuredOllamaDeps(installedTags: string[]): LocalRuntimeDeps {
	return {
		fetchFn: (async (url: string) => {
			const u = String(url);
			if (u.endsWith("/api/tags"))
				return Response.json({ models: installedTags.map((name) => ({ name, size: 1_000 })) });
			if (u.endsWith("/api/ps")) return Response.json({ models: [] });
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch,
		existsFn: () => true,
		spawnFn: () => {
			throw new Error("must not spawn — a configured server is already reachable");
		},
		sleepFn: async () => {},
	};
}

function localRuntimeControllerOf(harness: Awaited<ReturnType<typeof createHarness>>): LocalRuntimeController {
	return (harness.session as unknown as { _localRuntimeController: LocalRuntimeController })._localRuntimeController;
}

describe("AgentSession reload — local-runtime reconcile is really wired end-to-end", () => {
	it("stops a confirmed local runtime that reload's real eligible-model set does not reference", async () => {
		const harness = await createHarness({ localRuntimeDeps: configuredOllamaDeps(["qwen3:0.6b"]) });
		try {
			const ctrl = localRuntimeControllerOf(harness);
			const model = localModel();

			// Confirm the Ollama model directly through the readiness gate (same as a routed turn would),
			// WITHOUT ever making it the session's foreground model and WITHOUT any router tier pointing
			// at it — so it is genuinely absent from `_collectEligibleLocalModelsForReconcile()`.
			expect((await ctrl.ensureLocalModelReady(model)).ready).toBe(true);
			expect(harness.session.model?.provider).not.toBe("ollama"); // sanity: not the foreground model

			const runtimeBefore = ctrl.getLocalRuntime("http://127.0.0.1:11434");
			expect(runtimeBefore).toBeInstanceOf(OllamaRuntime);
			const stopSpy = vi.spyOn(runtimeBefore, "stop");

			await harness.session.reload();

			expect(stopSpy).toHaveBeenCalledTimes(1);
			expect(ctrl.getLocalRuntime("http://127.0.0.1:11434")).not.toBe(runtimeBefore); // evicted
		} finally {
			harness.cleanup();
		}
	});

	it("leaves a local runtime alone when it IS the session's foreground model", async () => {
		const harness = await createHarness({ localRuntimeDeps: configuredOllamaDeps(["qwen3:0.6b"]) });
		try {
			const ctrl = localRuntimeControllerOf(harness);
			const model = localModel();

			await ctrl.ensureLocalModelReady(model);
			const runtimeBefore = ctrl.getLocalRuntime("http://127.0.0.1:11434");
			const stopSpy = vi.spyOn(runtimeBefore, "stop");

			// Directly seed the foreground model on the live agent state — bypasses setModel()'s auth
			// check (irrelevant here: only _collectEligibleLocalModelsForReconcile's own read matters).
			(harness.session as unknown as { agent: { state: { model: Model<Api> } } }).agent.state.model = model;

			await harness.session.reload();

			expect(stopSpy).not.toHaveBeenCalled();
			expect(ctrl.getLocalRuntime("http://127.0.0.1:11434")).toBe(runtimeBefore);
		} finally {
			harness.cleanup();
		}
	});
});

import { DEFAULT_CLOUD_STREAM_IDLE, DEFAULT_STREAM_IDLE } from "@caupulican/pi-agent-core/reliability";
import { fauxAssistantMessage } from "@caupulican/pi-ai";
import type { Api, Model } from "@caupulican/pi-ai/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveStreamStallBudget } from "../src/core/agent-session.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

/**
 * One `retry.stall` budget for every provider forced a choice between protecting a CPU-served
 * local model (minutes of legitimate silence) and noticing a dead cloud stream within a sane
 * time. The budgets are now class-scoped: local/managed models keep the generous bounds (and the
 * legacy top-level keys), cloud providers get {@link DEFAULT_CLOUD_STREAM_IDLE}. These tests pin
 * both halves — which class the session asks for while streaming, and which bounds that class
 * resolves to.
 */
describe("stream-stall budgets per model class", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	/** A model identical to the faux one except for a public endpoint, so it classifies as cloud. */
	function asCloudModel(model: Model<Api>): Model<Api> {
		return { ...model, baseUrl: "https://api.stall-budget-test.invalid/v1" };
	}

	async function recordStallClassesForPrompt(harness: Harness): Promise<string[]> {
		const requested: string[] = [];
		const settingsManager = harness.settingsManager;
		const readBudget = settingsManager.getStreamStallSettings.bind(settingsManager);
		vi.spyOn(settingsManager, "getStreamStallSettings").mockImplementation((modelClass) => {
			requested.push(modelClass);
			return readBudget(modelClass);
		});
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("hello");
		vi.restoreAllMocks();
		return requested;
	}

	it("asks for the local budget while streaming a local model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const requested = await recordStallClassesForPrompt(harness);

		expect(requested.length).toBeGreaterThan(0);
		expect([...new Set(requested)]).toEqual(["local"]);
	});

	it("asks for the cloud budget while streaming a cloud model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.setModel(asCloudModel(harness.getModel()), { persistSettings: false });

		const requested = await recordStallClassesForPrompt(harness);

		expect(requested.length).toBeGreaterThan(0);
		expect([...new Set(requested)]).toEqual(["cloud"]);
	});

	it("gives a local model the legacy bounds and a cloud model the cloud defaults", async () => {
		// The owner's settings file still carries the pre-split top-level keys.
		const harness = await createHarness({
			settings: { retry: { stall: { connectMs: 300_000, activeIdleMs: 300_000, quietIdleMs: 900_000 } } },
		});
		harnesses.push(harness);

		const local = resolveStreamStallBudget(harness.getModel(), harness.settingsManager);
		expect(local.modelClass).toBe("local");
		expect(local.base).toEqual({
			...DEFAULT_STREAM_IDLE,
			connectMs: 300_000,
			activeIdleMs: 300_000,
			quietIdleMs: 900_000,
		});

		const cloud = resolveStreamStallBudget(asCloudModel(harness.getModel()), harness.settingsManager);
		expect(cloud.modelClass).toBe("cloud");
		expect(cloud.base).toEqual(DEFAULT_CLOUD_STREAM_IDLE);
		expect(cloud.base.connectMs).toBe(120_000);
		expect(cloud.base.activeIdleMs).toBe(120_000);
		expect(cloud.base.quietIdleMs).toBe(300_000);
	});

	it("gives each class its own configured budget when both are named", async () => {
		const harness = await createHarness({
			settings: {
				retry: {
					stall: {
						local: { connectMs: 300_000, activeIdleMs: 300_000, quietIdleMs: 900_000 },
						cloud: { connectMs: 45_000, activeIdleMs: 60_000, quietIdleMs: 90_000 },
					},
				},
			},
		});
		harnesses.push(harness);

		expect(resolveStreamStallBudget(harness.getModel(), harness.settingsManager).base).toEqual({
			...DEFAULT_STREAM_IDLE,
			connectMs: 300_000,
			activeIdleMs: 300_000,
			quietIdleMs: 900_000,
		});
		expect(resolveStreamStallBudget(asCloudModel(harness.getModel()), harness.settingsManager).base).toEqual({
			...DEFAULT_CLOUD_STREAM_IDLE,
			connectMs: 45_000,
			activeIdleMs: 60_000,
			quietIdleMs: 90_000,
		});
	});
});

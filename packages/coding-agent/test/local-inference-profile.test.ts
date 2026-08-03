import { describe, expect, it } from "vitest";
import {
	deriveHostLocalInferenceProfile,
	deriveLocalInferenceProfile,
} from "../src/core/models/local-inference-profile.ts";

describe("local inference resource profiles", () => {
	it("bounds validation on a 10 GiB host without forcing a cold start between turns", () => {
		const profile = deriveLocalInferenceProfile({
			mode: "low-impact",
			totalMemoryBytes: 10 * 1024 ** 3,
			logicalCpuCount: 16,
		});

		expect(profile).toEqual({
			mode: "low-impact",
			promptCacheMiB: 256,
			maxLoadedModels: 1,
			parallelRequests: 1,
			maxQueuedRequests: 1,
			keepAlive: "2m",
			kvCacheType: "q8_0",
			flashAttention: true,
			generationThreads: 2,
			batchThreads: 2,
		});
	});

	it("keeps a small host warm but caps cache, residency, queueing, and CPU pressure", () => {
		const profile = deriveLocalInferenceProfile({
			mode: "balanced",
			totalMemoryBytes: 10 * 1024 ** 3,
			logicalCpuCount: 16,
		});

		expect(profile).toMatchObject({
			mode: "balanced",
			promptCacheMiB: 512,
			maxLoadedModels: 1,
			parallelRequests: 1,
			maxQueuedRequests: 4,
			keepAlive: "10m",
			generationThreads: 4,
			batchThreads: 4,
		});
	});

	it("uses additional cache and residency only when host memory can absorb them", () => {
		const profile = deriveLocalInferenceProfile({
			mode: "balanced",
			totalMemoryBytes: 64 * 1024 ** 3,
			logicalCpuCount: 32,
		});

		expect(profile).toMatchObject({
			promptCacheMiB: 2_048,
			maxLoadedModels: 2,
			parallelRequests: 1,
			generationThreads: 8,
			batchThreads: 8,
		});
	});

	it("never requests more threads than the host exposes", () => {
		expect(
			deriveLocalInferenceProfile({
				mode: "balanced",
				totalMemoryBytes: 4 * 1024 ** 3,
				logicalCpuCount: 1,
			}),
		).toMatchObject({ generationThreads: 1, batchThreads: 1, maxLoadedModels: 1 });
	});

	it("owns host-capacity probing for every runtime adapter", () => {
		const profile = deriveHostLocalInferenceProfile("balanced", {
			totalMemoryBytes: () => 32 * 1024 ** 3,
			logicalCpuCount: () => 3,
		});

		expect(profile).toMatchObject({
			promptCacheMiB: 1_024,
			maxLoadedModels: 2,
			generationThreads: 3,
			batchThreads: 3,
		});
	});
});

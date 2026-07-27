import { describe, expect, it } from "vitest";
import {
	createLocalWorkerProcessOwnerId,
	localWorkerProcessOwnerLiveness,
	parseLocalWorkerProcessOwnerId,
} from "../src/core/delegation/worker-process-owner.ts";

describe("local worker process owner identities", () => {
	it("creates and parses a bounded local owner identity", () => {
		const ownerId = createLocalWorkerProcessOwnerId(42, "11111111-1111-4111-8111-111111111111");
		expect(ownerId).toBe("pi-worker:42:11111111-1111-4111-8111-111111111111");
		expect(parseLocalWorkerProcessOwnerId(ownerId)).toEqual({
			pid: 42,
			instanceId: "11111111-1111-4111-8111-111111111111",
		});
	});

	it("distinguishes a live, dead, and unknown owner without probing malformed identities", () => {
		expect(
			localWorkerProcessOwnerLiveness("pi-worker:7:11111111-1111-4111-8111-111111111111", (pid) => pid === 7),
		).toBe("live");
		expect(localWorkerProcessOwnerLiveness("pi-worker:8:11111111-1111-4111-8111-111111111111", () => false)).toBe(
			"dead",
		);
		expect(localWorkerProcessOwnerLiveness("pi-worker:8:not-a-uuid", () => false)).toBe("unknown");
		expect(
			localWorkerProcessOwnerLiveness("pi-worker:9:11111111-1111-4111-8111-111111111111", () => {
				throw new Error("permission denied");
			}),
		).toBe("unknown");
	});
});

import { describe, expect, it, vi } from "vitest";
import { RealWorkerDispatcher } from "../src/core/adaptive/execution-ports.ts";

describe("RealWorkerDispatcher", () => {
	it("keeps its session receiver when an execution coordinator invokes a detached dispatch port", async () => {
		const runWorkerDelegationOnce = vi.fn(async () => ({}));
		const dispatcher = new RealWorkerDispatcher({ runWorkerDelegationOnce });
		const detachedDispatch = dispatcher.dispatch;

		await expect(detachedDispatch({ route: "review", action: "review" } as never)).resolves.toBeUndefined();
		expect(runWorkerDelegationOnce).toHaveBeenCalledWith(
			expect.objectContaining({ instructions: "Execute objective route review" }),
		);
	});
});

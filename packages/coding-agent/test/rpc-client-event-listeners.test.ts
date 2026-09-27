import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

function deliverLine(client: RpcClient, line: string): void {
	(client as unknown as { handleLine(line: string): void }).handleLine(line);
}

describe("RpcClient event listeners", () => {
	it("isolates observers so one failure cannot suppress wait and collection subscribers", () => {
		const client = new RpcClient();
		client.onEvent(() => {
			throw new Error("broken RPC observer");
		});
		const healthyObserver = vi.fn();
		client.onEvent(healthyObserver);
		const event = { type: "agent_end", messages: [], willRetry: false };

		expect(() => deliverLine(client, JSON.stringify(event))).not.toThrow();
		expect(healthyObserver).toHaveBeenCalledExactlyOnceWith(event);
	});
});

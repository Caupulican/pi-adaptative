import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	send: (command: { type: string }) => Promise<unknown>;
	getData: <T>(response: unknown) => T;
};

describe("RpcClient clearQueue (D8)", () => {
	it("sends the clear_queue RPC command and returns steering/followUp/commands", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async () => ({
			type: "response",
			command: "clear_queue",
			success: true,
			data: { steering: ["s1"], followUp: ["f1"], commands: ["c1"] },
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => {
			return (response as { data: T }).data;
		};

		const result = await client.clearQueue();

		expect(send).toHaveBeenCalledWith({ type: "clear_queue" });
		expect(result).toEqual({ steering: ["s1"], followUp: ["f1"], commands: ["c1"] });
	});
});

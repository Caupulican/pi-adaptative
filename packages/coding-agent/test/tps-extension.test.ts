import type { ExtensionAPI } from "@caupulican/pi-adaptative";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerTpsExtension from "../src/bundled-resources/extensions/tps/index.ts";

type AgentStartHandler = () => void;
type AgentEndHandler = (
	event: { messages: Array<{ role: string; usage: { output: number } }> },
	ctx: { hasUI: boolean; ui: { setStatus: (key: string, text: string) => void } },
) => void;

describe("TPS extension", () => {
	afterEach(() => vi.restoreAllMocks());

	it("contributes only the live rate chip to the footer", () => {
		let onAgentStart: AgentStartHandler | undefined;
		let onAgentEnd: AgentEndHandler | undefined;
		const pi = {
			on(event: string, handler: unknown) {
				if (event === "agent_start") onAgentStart = handler as AgentStartHandler;
				if (event === "agent_end") onAgentEnd = handler as AgentEndHandler;
			},
		} as unknown as ExtensionAPI;
		registerTpsExtension(pi);
		vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(3_000);
		const setStatus = vi.fn();

		onAgentStart?.();
		onAgentEnd?.({ messages: [{ role: "assistant", usage: { output: 120 } }] }, { hasUI: true, ui: { setStatus } });

		expect(setStatus).toHaveBeenCalledWith("tps", "TPS 60.0 tok/s");
	});
});

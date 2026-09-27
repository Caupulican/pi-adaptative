import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession event listeners", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("uses a stable listener generation when a listener unsubscribes and adds another listener", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		let healthyStarts = 0;
		let lateStarts = 0;
		let unsubscribeFirst = (): void => undefined;
		unsubscribeFirst = harness.session.subscribe((event) => {
			if (event.type !== "agent_start") return;
			harness.session.subscribe((lateEvent) => {
				if (lateEvent.type === "agent_start") lateStarts++;
			});
			unsubscribeFirst();
		});
		harness.session.subscribe((event) => {
			if (event.type === "agent_start") healthyStarts++;
		});

		await harness.session.prompt("hello");

		expect({ healthyStarts, lateStarts }).toEqual({ healthyStarts: 1, lateStarts: 0 });
	});
});

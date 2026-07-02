import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "./suite/harness.ts";

const JUDGE_MEDIUM = '{"tier":"medium","risk":"read-only","trivial":false,"reason":"non-trivial planning"}';

describe("AgentSession route judge", () => {
	it("upgrades a cheap baseline to medium when the judge says so, and runs the turn on the medium model", async () => {
		const harness = await createHarness({
			models: [{ id: "cheap" }, { id: "medium" }],
			settings: {
				modelRouter: { enabled: true, cheapModel: "faux/cheap", mediumModel: "faux/medium" },
			},
		});
		try {
			let judgeModelId: string | undefined;
			let turnModelId: string | undefined;
			harness.setResponses([
				(_context, _options, _state, model) => {
					judgeModelId = model.id;
					return fauxAssistantMessage(JUDGE_MEDIUM);
				},
				(_context, _options, _state, model) => {
					turnModelId = model.id;
					return fauxAssistantMessage("answered on medium");
				},
			]);

			await harness.session.prompt("what's the cleanest structure for the cache invalidation subsystem?");

			// The judge itself runs on the judge lane (mediumModel fallback) and the turn on the judged tier.
			expect(judgeModelId).toBe("medium");
			expect(turnModelId).toBe("medium");
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps the baseline visibly when the judge output is unparseable", async () => {
		const harness = await createHarness({
			models: [{ id: "cheap" }, { id: "medium" }],
			settings: {
				modelRouter: { enabled: true, cheapModel: "faux/cheap", mediumModel: "faux/medium" },
			},
		});
		try {
			let turnModelId: string | undefined;
			harness.setResponses([
				fauxAssistantMessage("hmm, probably medium I guess"),
				(_context, _options, _state, model) => {
					turnModelId = model.id;
					return fauxAssistantMessage("answered on cheap");
				},
			]);

			await harness.session.prompt("what does the session manager do?");

			expect(turnModelId).toBe("cheap");
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("skips the judge entirely when judgeEnabled is false", async () => {
		const harness = await createHarness({
			models: [{ id: "cheap" }, { id: "medium" }],
			settings: {
				modelRouter: { enabled: true, cheapModel: "faux/cheap", mediumModel: "faux/medium", judgeEnabled: false },
			},
		});
		try {
			let turnModelId: string | undefined;
			harness.setResponses([
				(_context, _options, _state, model) => {
					turnModelId = model.id;
					return fauxAssistantMessage("answered directly");
				},
			]);

			await harness.session.prompt("what does the session manager do?");

			expect(turnModelId).toBe("cheap");
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("skips the judge when no judge lane is configured (no mediumModel/judgeModel)", async () => {
		const harness = await createHarness({
			models: [{ id: "cheap" }, { id: "expensive" }],
			settings: {
				modelRouter: { enabled: true, cheapModel: "faux/cheap", expensiveModel: "faux/expensive" },
			},
		});
		try {
			harness.setResponses([fauxAssistantMessage("answered")]);
			await harness.session.prompt("what does the session manager do?");
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});
});

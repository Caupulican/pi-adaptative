import type { SimpleStreamOptions } from "@caupulican/pi-ai";
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

	it("applies a configured judgeThinking to the judge's own completion", async () => {
		const harness = await createHarness({
			models: [{ id: "cheap" }, { id: "medium" }],
			settings: {
				modelRouter: {
					enabled: true,
					cheapModel: "faux/cheap",
					mediumModel: "faux/medium",
					judgeThinking: "low",
				},
			},
		});
		try {
			let judgeReasoning: string | undefined;
			harness.setResponses([
				(_context, options) => {
					// FauxResponseFactory types `options` as the generic StreamOptions, but this call
					// arrives via runIsolatedCompletion -> streamSimple, which always carries
					// SimpleStreamOptions (adds `reasoning`) — narrow here to read the real shape.
					judgeReasoning = (options as SimpleStreamOptions | undefined)?.reasoning;
					return fauxAssistantMessage(JUDGE_MEDIUM);
				},
				fauxAssistantMessage("answered on medium"),
			]);

			await harness.session.prompt("what's the cleanest structure for the cache invalidation subsystem?");

			// Today's default (no judgeThinking configured) is "off" — this proves the configured
			// level reaches the judge's isolated completion instead of that hardcoded default.
			expect(judgeReasoning).toBe("low");
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

	// Bug: the judge is a bounded LLM completion (seconds), not a regex — awaiting it before the
	// user's own message is ever displayed makes the prompt appear to hang. The message must paint
	// immediately, then routing (the judge) happens.
	it("paints the user's message before the routing judge's completion is dispatched", async () => {
		const harness = await createHarness({
			models: [{ id: "cheap" }, { id: "medium" }],
			settings: {
				modelRouter: { enabled: true, cheapModel: "faux/cheap", mediumModel: "faux/medium" },
			},
		});
		try {
			const order: string[] = [];
			harness.session.subscribe((event) => {
				if (event.type === "message_start" && event.message.role === "user") {
					order.push("message_start:user");
				}
			});
			harness.setResponses([
				() => {
					order.push("judge:dispatch");
					return fauxAssistantMessage(JUDGE_MEDIUM);
				},
				fauxAssistantMessage("answered on medium"),
			]);

			await harness.session.prompt("Implement a small fix and update the relevant unit test.");

			expect(order).toEqual(["message_start:user", "judge:dispatch"]);
		} finally {
			harness.cleanup();
		}
	});

	it("still displays and persists the user's message exactly once when the judge runs", async () => {
		const harness = await createHarness({
			models: [{ id: "cheap" }, { id: "medium" }],
			settings: {
				modelRouter: { enabled: true, cheapModel: "faux/cheap", mediumModel: "faux/medium" },
			},
		});
		try {
			harness.setResponses([fauxAssistantMessage(JUDGE_MEDIUM), fauxAssistantMessage("answered on medium")]);

			await harness.session.prompt("Implement a small fix and update the relevant unit test.");

			// Exactly one visible user message_start, no duplicate paint.
			const userStarts = harness.eventsOfType("message_start").filter((event) => event.message.role === "user");
			expect(userStarts).toHaveLength(1);

			// Persisted transcript order is unaffected: user before assistant, no dupes.
			const persistedRoles = harness.sessionManager
				.getEntries()
				.filter((entry): entry is Extract<typeof entry, { type: "message" }> => entry.type === "message")
				.map((entry) => entry.message.role);
			expect(persistedRoles).toEqual(["user", "assistant"]);
		} finally {
			harness.cleanup();
		}
	});

	// Part B: while the judge (or any other prep before the turn streams) runs, the UI has nothing to
	// show the user other than their own echoed prompt — routing_start/routing_end bracket that gap so
	// interactive-mode can paint a "working…" indicator for it, independent of thinking level.
	describe("routing_start/routing_end (working-spinner-during-judge bracket)", () => {
		it("emits routing_start before the judge is dispatched and routing_end before the turn starts streaming", async () => {
			const harness = await createHarness({
				models: [{ id: "cheap" }, { id: "medium" }],
				settings: {
					modelRouter: { enabled: true, cheapModel: "faux/cheap", mediumModel: "faux/medium" },
				},
			});
			try {
				const order: string[] = [];
				harness.session.subscribe((event) => {
					if (event.type === "routing_start") order.push("routing_start");
					if (event.type === "routing_end") order.push("routing_end");
					if (event.type === "agent_start") order.push("agent_start");
				});
				harness.setResponses([
					() => {
						order.push("judge:dispatch");
						return fauxAssistantMessage(JUDGE_MEDIUM);
					},
					fauxAssistantMessage("answered on medium"),
				]);

				await harness.session.prompt("Implement a small fix and update the relevant unit test.");

				expect(order).toEqual(["routing_start", "judge:dispatch", "routing_end", "agent_start"]);
			} finally {
				harness.cleanup();
			}
		});

		it("emits exactly one routing_start/routing_end pair even when the router is disabled (no judge to await)", async () => {
			const harness = await createHarness();
			try {
				harness.setResponses([fauxAssistantMessage("hi")]);

				await harness.session.prompt("hello");

				expect(harness.eventsOfType("routing_start")).toHaveLength(1);
				expect(harness.eventsOfType("routing_end")).toHaveLength(1);
			} finally {
				harness.cleanup();
			}
		});

		it("emits routing_end even when the turn fails before ever reaching the model call, so nothing is left spinning", async () => {
			const harness = await createHarness({ withConfiguredAuth: false });
			try {
				harness.setResponses([fauxAssistantMessage("unreachable")]);

				await expect(harness.session.prompt("hello")).rejects.toThrow();

				expect(harness.eventsOfType("routing_start")).toHaveLength(1);
				expect(harness.eventsOfType("routing_end")).toHaveLength(1);
				// The turn never started: no agent_start reached.
				expect(harness.eventsOfType("agent_start")).toHaveLength(0);
			} finally {
				harness.cleanup();
			}
		});

		it("does not emit routing_start/routing_end when an extension's input handler fully handles the prompt", async () => {
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input", async (event) => {
							if (event.text === "ping") {
								return { action: "handled" };
							}
							return { action: "continue" };
						});
					},
				],
			});
			try {
				harness.setResponses([fauxAssistantMessage("hi")]);

				// "ping" is fully handled by the extension — never reaches the routing/prep phase.
				await harness.session.prompt("ping");
				expect(harness.eventsOfType("routing_start")).toHaveLength(0);
				expect(harness.eventsOfType("routing_end")).toHaveLength(0);

				// A normal prompt still gets the bracket, proving the extension isn't just swallowing
				// the events globally.
				await harness.session.prompt("hello");
				expect(harness.eventsOfType("routing_start")).toHaveLength(1);
				expect(harness.eventsOfType("routing_end")).toHaveLength(1);
			} finally {
				harness.cleanup();
			}
		});
	});
});

import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

/**
 * A compaction applied between runs replaces the history the agent's sent-prefix marks were counting.
 * The marks must drop to zero (none of the compacted history has been sent in its new form); otherwise the
 * monotone mark write keeps the pre-compaction count and the whole compacted history reads as already
 * sent, so context GC cannot pack it and the sanitizer cannot dedup it until it regrows past that count.
 */

type AgentPrefixMarks = { sentPrefixCount: number; sanitizerSentPrefixCount: number };

describe("compaction resets the sent-prefix horizon", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("drops both marks to zero when a compaction replaces the history", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const marks = harness.session.agent as unknown as AgentPrefixMarks;
		expect(marks.sentPrefixCount).toBeGreaterThan(0);
		expect(marks.sanitizerSentPrefixCount).toBeGreaterThan(0);

		await harness.session.compact();

		expect(marks.sentPrefixCount).toBe(0);
		expect(marks.sanitizerSentPrefixCount).toBe(0);
	});
});

import { describe, expect, it } from "vitest";
import { OwnerPolicyQueue, type OwnerWords } from "../src/core/system-one/owner-policy-queue.ts";

function harness(carries?: (texts: readonly string[]) => readonly boolean[] | undefined) {
	const classified: string[] = [];
	const screens: string[][] = [];
	const queue = new OwnerPolicyQueue({
		classify: async (words: OwnerWords) => {
			classified.push(words.text);
		},
		screen: async (texts) => {
			screens.push([...texts]);
			return carries?.(texts);
		},
	});
	return { queue, classified, screens };
}

describe("OwnerPolicyQueue", () => {
	it("a turn that never settles costs no classification", () => {
		const { queue, classified, screens } = harness();
		queue.enqueue({ text: "hi" });
		expect(queue.size).toBe(1);
		expect(classified).toEqual([]);
		expect(screens).toEqual([]);
	});

	it("classifies the newest message in full with no screen when it is alone", async () => {
		const { queue, classified, screens } = harness();
		queue.enqueue({ text: "fix the build" });
		await queue.settle("latest");
		expect(classified).toEqual(["fix the build"]);
		expect(screens).toEqual([]);
		expect(queue.size).toBe(0);
	});

	it("a second settle finds nothing left to classify", async () => {
		const { queue, classified } = harness();
		queue.enqueue({ text: "fix the build" });
		await Promise.all([queue.settle("latest"), queue.settle("latest")]);
		expect(classified).toEqual(["fix the build"]);
	});

	it("screens a backlog in one request and classifies only the messages the screen does not set aside, in order", async () => {
		const { queue, classified, screens } = harness((texts) =>
			texts.map((text) => text !== "hi" && text !== "thanks"),
		);
		for (const text of ["hi", "no push", "thanks", "you can push now"]) queue.enqueue({ text });
		await queue.settle("backlog");
		expect(screens).toEqual([["hi", "no push", "thanks", "you can push now"]]);
		expect(classified).toEqual(["no push", "you can push now"]);
	});

	it("classifies the newest in full even when older messages are screened away", async () => {
		const { queue, classified, screens } = harness((texts) => texts.map(() => false));
		queue.enqueue({ text: "hi" });
		queue.enqueue({ text: "thanks" });
		queue.enqueue({ text: "now commit it" });
		await queue.settle("latest");
		expect(screens).toEqual([["hi", "thanks"]]);
		expect(classified).toEqual(["now commit it"]);
	});

	it("an unavailable screen classifies every message in full", async () => {
		const { queue, classified } = harness(() => undefined);
		queue.enqueue({ text: "a" });
		queue.enqueue({ text: "b" });
		await queue.settle("backlog");
		expect(classified).toEqual(["a", "b"]);
	});

	it("a failed classification keeps the messages it did not reach", async () => {
		let fail = true;
		const classified: string[] = [];
		const queue = new OwnerPolicyQueue({
			classify: async (words) => {
				if (fail && words.text === "b") throw new Error("boom");
				classified.push(words.text);
			},
			screen: async (texts) => texts.map(() => true),
		});
		for (const text of ["a", "b", "c"]) queue.enqueue({ text });
		await expect(queue.settle("backlog")).rejects.toThrow("boom");
		expect(classified).toEqual(["a"]);
		expect(queue.size).toBe(2);
		fail = false;
		await queue.settle("backlog");
		expect(classified).toEqual(["a", "b", "c"]);
	});
});

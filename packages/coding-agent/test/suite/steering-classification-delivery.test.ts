import { getEventListeners } from "node:events";
import type { ImageContent } from "@caupulican/pi-ai";
import { type FauxResponseFactory, fauxAssistantMessage } from "@caupulican/pi-ai/faux";
import type { AssistantMessage } from "@caupulican/pi-ai/types";
import { describe, expect, it } from "vitest";
import type { JevEvaluationRequest } from "../../src/core/system-one/adapter.ts";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { type KeyHandlersHost, setupKeyHandlers } from "../../src/modes/interactive/key-handlers.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * Every accepted owner steering submission reaches a provider request in submission order. Owner
 * intent classification runs before a queued message is admitted; a newer classification makes an
 * older JUDGMENT stale, but the older MESSAGE is still the owner's input and is still delivered.
 */

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** A classifier whose judgment for each held request text is released by the test. */
function heldClassifier(held: readonly string[], options: { honorsAbort: boolean; fails?: boolean }) {
	const entered = new Map(held.map((text) => [text, deferred()]));
	const release = new Map(held.map((text) => [text, deferred()]));
	const signals = new Map<string, AbortSignal>();
	const controller = new SystemOneController({
		store: new ExecutionStore({
			run_id: "steering-delivery",
			objective: { request: "", normalized_goal: "", acceptance_criteria: [], constraints: [] },
			repo: { root: "/repo", baseline_revision: "baseline" },
		}),
		adapter: {
			evaluate: async (input: JevEvaluationRequest, evaluateOptions) => {
				const request = (input.state as { user_request?: string }).user_request;
				const gate = request === undefined ? undefined : release.get(request);
				if (request !== undefined && evaluateOptions?.signal) signals.set(request, evaluateOptions.signal);
				if (request !== undefined && gate) {
					entered.get(request)?.resolve();
					const signal = evaluateOptions?.signal;
					await (options.honorsAbort && signal
						? Promise.race([
								gate.promise,
								new Promise<void>((_resolve, reject) => {
									if (signal.aborted) reject(signal.reason);
									signal.addEventListener("abort", () => reject(signal.reason), { once: true });
								}),
							])
						: gate.promise);
				}
				if (options.fails && request !== undefined) throw new Error("evaluator outage");
				return { model: "jev-1.13.0", answers: { changes_model_pools: { noul: 0.01 } }, latency_ms: 1 };
			},
		},
	});
	return {
		controller,
		entered: (text: string) => entered.get(text)!.promise,
		release: (text: string) => release.get(text)!.resolve(),
		signal: (text: string) => signals.get(text),
	};
}

function userTexts(messages: readonly unknown[]): string[] {
	return messages.flatMap((message) => {
		const value = message as { role?: string; content?: unknown };
		if (value.role !== "user") return [];
		if (typeof value.content === "string") return [value.content];
		if (!Array.isArray(value.content)) return [];
		const text = value.content
			.filter((part: { type?: string }) => part.type === "text")
			.map((part: { text?: string }) => part.text ?? "")
			.join("");
		const images = value.content.filter((part: { type?: string }) => part.type === "image").length;
		return [images > 0 ? `${text} [${images} image]` : text];
	});
}

/** The first provider request is held open; every request's user messages are captured. */
function heldProvider(harness: Harness) {
	const requests: string[][] = [];
	const firstSeen = deferred();
	const releaseFirst = deferred<AssistantMessage>();
	const first: FauxResponseFactory = (context) => {
		requests.push(userTexts(context.messages));
		firstSeen.resolve();
		return releaseFirst.promise;
	};
	const later: FauxResponseFactory = (context) => {
		requests.push(userTexts(context.messages));
		return fauxAssistantMessage("done");
	};
	harness.setResponses([first, ...Array.from({ length: 8 }, () => later)]);
	return {
		requests,
		firstSeen: firstSeen.promise,
		releaseFirst: () => releaseFirst.resolve(fauxAssistantMessage("first turn done")),
	};
}

const STEERS = ["first steer", "second steer", "third steer"];

async function steeringHarness(options: { honorsAbort: boolean; mode?: "all" | "one-at-a-time" }) {
	const classifier = heldClassifier(STEERS, options);
	const harness = await createHarness({
		systemOneController: classifier.controller,
		settings: { modelRouter: { enabled: false } },
	});
	if (options.mode) harness.session.setSteeringMode(options.mode);
	const provider = heldProvider(harness);
	const run = harness.session.prompt("Start work");
	await provider.firstSeen;
	return { harness, classifier, provider, run };
}

type Submit = (harness: Harness, text: string, images?: ImageContent[]) => Promise<void>;
const SUBMIT_PATHS: [string, Submit][] = [
	["steer()", (harness, text, images) => harness.session.steer(text, images)],
	[
		'prompt(streamingBehavior: "steer")',
		(harness, text, images) =>
			harness.session.prompt(text, { streamingBehavior: "steer", ...(images ? { images } : {}) }),
	],
];

describe("queued owner steering survives a newer owner classification", () => {
	for (const [label, submit] of SUBMIT_PATHS) {
		for (const honorsAbort of [true, false]) {
			for (const order of [
				[0, 1, 2],
				[2, 1, 0],
			]) {
				it(`${label}: three steers, classifier ${honorsAbort ? "honors" : "ignores"} abort, released ${order.join(",")}`, async () => {
					const { harness, classifier, provider, run } = await steeringHarness({ honorsAbort });
					try {
						const submissions: Promise<void>[] = [];
						for (const text of STEERS) {
							submissions.push(submit(harness, text));
							await classifier.entered(text);
						}
						for (const index of order) classifier.release(STEERS[index]!);
						await Promise.all(submissions);
						expect(harness.session.getSteeringMessages()).toEqual(STEERS);

						provider.releaseFirst();
						await run;
						expect(provider.requests[0]).toEqual(["Start work"]);
						expect(provider.requests.at(-1)).toEqual(["Start work", ...STEERS]);
						expect(harness.session.getSteeringMessages()).toEqual([]);
					} finally {
						harness.cleanup();
					}
				});
			}
		}
	}

	it("a third steer arriving while the second is being admitted keeps all three in order", async () => {
		const { harness, classifier, provider, run } = await steeringHarness({ honorsAbort: true });
		try {
			const first = harness.session.steer(STEERS[0]!);
			await classifier.entered(STEERS[0]!);
			classifier.release(STEERS[0]!);
			await first;
			const second = harness.session.steer(STEERS[1]!);
			await classifier.entered(STEERS[1]!);
			const third = harness.session.steer(STEERS[2]!);
			await classifier.entered(STEERS[2]!);
			classifier.release(STEERS[2]!);
			classifier.release(STEERS[1]!);
			await Promise.all([second, third]);
			expect(harness.session.getSteeringMessages()).toEqual(STEERS);
			provider.releaseFirst();
			await run;
			expect(provider.requests.at(-1)).toEqual(["Start work", ...STEERS]);
		} finally {
			harness.cleanup();
		}
	});

	it("one-at-a-time mode delivers every steer, one per request, in order", async () => {
		const { harness, classifier, provider, run } = await steeringHarness({
			honorsAbort: true,
			mode: "one-at-a-time",
		});
		try {
			const submissions = [];
			for (const text of STEERS) {
				submissions.push(harness.session.steer(text));
				await classifier.entered(text);
			}
			for (const text of STEERS) classifier.release(text);
			await Promise.all(submissions);
			expect(harness.session.getSteeringMessages()).toEqual(STEERS);
			provider.releaseFirst();
			await run;
			expect(provider.requests.slice(1)).toEqual([
				["Start work", STEERS[0]],
				["Start work", STEERS[0], STEERS[1]],
				["Start work", ...STEERS],
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("identical text with different attachments stays two inputs", async () => {
		const classifier = heldClassifier(["same words"], { honorsAbort: true });
		const harness = await createHarness({
			systemOneController: classifier.controller,
			settings: { modelRouter: { enabled: false } },
		});
		const provider = heldProvider(harness);
		const run = harness.session.prompt("Start work");
		await provider.firstSeen;
		try {
			const image = (data: string): ImageContent => ({ type: "image", data, mimeType: "image/png" });
			const plain = harness.session.prompt("same words", { streamingBehavior: "steer" });
			await classifier.entered("same words");
			const withImage = harness.session.prompt("same words", {
				streamingBehavior: "steer",
				images: [image("aGk=")],
			});
			classifier.release("same words");
			await Promise.all([plain, withImage]);
			provider.releaseFirst();
			await run;
			expect(provider.requests.at(-1)).toEqual(["Start work", "same words", "same words [1 image]"]);
		} finally {
			harness.cleanup();
		}
	});

	it("an older steer whose classifier never answers does not hold back a newer steer", async () => {
		const { harness, classifier, provider, run } = await steeringHarness({ honorsAbort: false });
		try {
			const older = harness.session.steer(STEERS[0]!);
			await classifier.entered(STEERS[0]!);
			const newer = harness.session.steer(STEERS[1]!);
			await classifier.entered(STEERS[1]!);
			classifier.release(STEERS[1]!);
			await Promise.all([older, newer]);
			expect(harness.session.getSteeringMessages()).toEqual([STEERS[0], STEERS[1]]);
			provider.releaseFirst();
			await run;
			expect(provider.requests.at(-1)).toEqual(["Start work", STEERS[0], STEERS[1]]);
		} finally {
			classifier.release(STEERS[0]!);
			harness.cleanup();
		}
	});

	it("control: a single steer is delivered", async () => {
		const { harness, classifier, provider, run } = await steeringHarness({ honorsAbort: true });
		try {
			const only = harness.session.steer(STEERS[0]!);
			await classifier.entered(STEERS[0]!);
			classifier.release(STEERS[0]!);
			await only;
			provider.releaseFirst();
			await run;
			expect(provider.requests.at(-1)).toEqual(["Start work", STEERS[0]]);
		} finally {
			harness.cleanup();
		}
	});

	it("control: without a classifier three steers are delivered in order", async () => {
		const harness = await createHarness({ settings: { modelRouter: { enabled: false } } });
		const provider = heldProvider(harness);
		const run = harness.session.prompt("Start work");
		await provider.firstSeen;
		try {
			for (const text of STEERS) await harness.session.steer(text);
			provider.releaseFirst();
			await run;
			expect(provider.requests.at(-1)).toEqual(["Start work", ...STEERS]);
		} finally {
			harness.cleanup();
		}
	});

	it("control: an owner abort during classification still cancels that submission", async () => {
		const { harness, classifier, provider, run } = await steeringHarness({ honorsAbort: true });
		try {
			const pending = harness.session.steer(STEERS[0]!);
			await classifier.entered(STEERS[0]!);
			provider.releaseFirst();
			await harness.session.abort("test owner cancellation");
			await pending;
			await run;
			expect(harness.session.getSteeringMessages()).toEqual([]);
			expect(provider.requests.flat()).not.toContain(STEERS[0]);
		} finally {
			harness.cleanup();
		}
	});
});

/** An input extension that holds the queued prompt submission for one exact text. */
function heldInputTransform(text: string) {
	const entered = deferred();
	const release = deferred();
	return {
		entered: entered.promise,
		release: () => release.resolve(),
		factory: (pi: {
			on(event: "input", handler: (event: { text: string }) => Promise<{ action: "continue" }>): void;
		}) => {
			pi.on("input", async (event) => {
				if (event.text === text) {
					entered.resolve();
					await release.promise;
				}
				return { action: "continue" };
			});
		},
	};
}

async function mixedHarness(heldText: string) {
	const classifier = heldClassifier([], { honorsAbort: true });
	const transform = heldInputTransform(heldText);
	const harness = await createHarness({
		systemOneController: classifier.controller,
		settings: { modelRouter: { enabled: false } },
		extensionFactories: [transform.factory as never],
	});
	const provider = heldProvider(harness);
	const run = harness.session.prompt("Start work");
	await provider.firstSeen;
	return { harness, transform, provider, run };
}

const steerPrompt = (harness: Harness, text: string, images?: ImageContent[]) =>
	harness.session.prompt(text, { streamingBehavior: "steer", ...(images ? { images } : {}) });

describe("one admission order for every queued owner input", () => {
	it("an older prompt-path steer held in its input transform still precedes a later direct steer", async () => {
		const { harness, transform, provider, run } = await mixedHarness("older via prompt");
		try {
			const older = steerPrompt(harness, "older via prompt");
			await transform.entered;
			await harness.session.steer("newer direct");
			// Both are pending, in submission order, before the older one is admitted.
			expect(harness.session.getSteeringMessages()).toEqual(["older via prompt", "newer direct"]);
			transform.release();
			await older;
			provider.releaseFirst();
			await run;
			expect(provider.requests.at(-1)).toEqual(["Start work", "older via prompt", "newer direct"]);
		} finally {
			harness.cleanup();
		}
	});

	it("an older direct steer precedes a later prompt-path steer held in its input transform", async () => {
		const { harness, transform, provider, run } = await mixedHarness("newer via prompt");
		try {
			await harness.session.steer("older direct");
			const newer = steerPrompt(harness, "newer via prompt");
			await transform.entered;
			transform.release();
			await newer;
			provider.releaseFirst();
			await run;
			expect(provider.requests.at(-1)).toEqual(["Start work", "older direct", "newer via prompt"]);
		} finally {
			harness.cleanup();
		}
	});

	it("alternating paths keep three submissions, identical text and attachments in order", async () => {
		const { harness, transform, provider, run } = await mixedHarness("same words");
		try {
			const image: ImageContent = { type: "image", data: "aGk=", mimeType: "image/png" };
			const first = steerPrompt(harness, "same words", [image]);
			await transform.entered;
			const second = harness.session.steer("same words");
			const third = steerPrompt(harness, "third words");
			transform.release();
			await Promise.all([first, second, third]);
			provider.releaseFirst();
			await run;
			expect(provider.requests.at(-1)).toEqual(["Start work", "same words [1 image]", "same words", "third words"]);
			const transcript = harness.session.agent.state.messages.filter((message) => message.role === "user");
			expect(userTexts(transcript)).toEqual(["Start work", "same words [1 image]", "same words", "third words"]);
			expect(harness.session.getSteeringMessages()).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});
});

describe("a queued input's admission is fenced by its live context", () => {
	it("disposal between a settled classification and admission delivers nothing", async () => {
		const harness = await createHarness({ settings: { modelRouter: { enabled: false } } });
		try {
			const pending = harness.session.steer("never after disposal");
			harness.session.dispose();
			await pending;
			expect(harness.session.getSteeringMessages()).toEqual([]);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	it("an owner interrupt between a settled classification and admission cancels the input", async () => {
		const harness = await createHarness({ settings: { modelRouter: { enabled: false } } });
		try {
			const pending = harness.session.steer("interrupted before admission");
			const interrupt = harness.session.abort("test owner interrupt");
			await Promise.all([pending, interrupt]);
			expect(harness.session.getSteeringMessages()).toEqual([]);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	it("control: a superseded older steer is admitted; a later interrupt cancels only the undecided newer one", async () => {
		const { harness, classifier, provider, run } = await steeringHarness({ honorsAbort: true });
		try {
			const older = harness.session.steer(STEERS[0]!);
			await classifier.entered(STEERS[0]!);
			const newer = harness.session.steer(STEERS[1]!);
			await classifier.entered(STEERS[1]!);
			await older;
			expect.soft(harness.session.getSteeringMessages()).toEqual([STEERS[0], STEERS[1]]);
			const interrupt = harness.session.abort("test owner interrupt");
			expect(harness.session.getSteeringMessages()).toEqual([STEERS[0]]);
			provider.releaseFirst();
			await Promise.all([newer, interrupt, run]);
			const later: FauxResponseFactory = (context) => {
				provider.requests.push(userTexts(context.messages));
				return fauxAssistantMessage("after interrupt");
			};
			harness.setResponses([later, later, later]);
			await harness.session.prompt("after interrupt");
			const delivered = provider.requests.flat();
			expect(delivered).toContain(STEERS[0]);
			expect(delivered).not.toContain(STEERS[1]);
		} finally {
			harness.cleanup();
		}
	});

	it("branch navigation during classification does not deliver the old-context input into the new branch", async () => {
		const classifier = heldClassifier(["before navigation"], { honorsAbort: false });
		const harness = await createHarness({
			systemOneController: classifier.controller,
			settings: { modelRouter: { enabled: false } },
		});
		try {
			harness.setResponses([fauxAssistantMessage("first done"), fauxAssistantMessage("second done")]);
			await harness.session.prompt("Start work");
			const target = harness.sessionManager
				.getEntries()
				.find((entry) => entry.type === "message" && entry.message.role === "user");
			if (!target) throw new Error("Expected the first user entry.");
			const pending = harness.session.steer("before navigation");
			await classifier.entered("before navigation");
			await harness.session.navigateTree(target.id);
			classifier.release("before navigation");
			await pending;
			// Not delivered into the new branch, and not lost: held in full in the pending queue.
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
			expect(harness.session.getSteeringMessages()).toEqual(["before navigation"]);
			expect(harness.eventsOfType("warning").some((event) => event.message.includes("before navigation"))).toBe(
				true,
			);
			expect(harness.session.takeQueuedMessages().steering).toEqual([
				{ text: "before navigation", images: undefined },
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("control: disposal during classification delivers nothing", async () => {
		const classifier = heldClassifier([STEERS[0]!], { honorsAbort: false });
		const harness = await createHarness({
			systemOneController: classifier.controller,
			settings: { modelRouter: { enabled: false } },
		});
		try {
			const pending = harness.session.steer(STEERS[0]!);
			await classifier.entered(STEERS[0]!);
			harness.session.dispose();
			classifier.release(STEERS[0]!);
			await pending;
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		} finally {
			harness.cleanup();
		}
	});
});

describe("the interrupt key recovers queued input still awaiting admission", () => {
	it("Escape restores an awaiting submission with queued input, and a late judgment never enqueues it", async () => {
		const { harness, classifier, provider, run } = await steeringHarness({ honorsAbort: false });
		try {
			const admittedFirst = harness.session.steer(STEERS[0]!);
			await classifier.entered(STEERS[0]!);
			classifier.release(STEERS[0]!);
			await admittedFirst;
			const awaiting = steerPrompt(harness, STEERS[1]!);
			await classifier.entered(STEERS[1]!);
			// Pending from submission: the awaiting input is visible before any decision admits it.
			expect.soft(harness.session.getSteeringMessages()).toEqual([STEERS[0], STEERS[1]]);

			const editorText: string[] = [];
			const tui = Object.assign(Object.create(InteractiveMode.prototype) as object, {
				runtimeHost: { session: harness.session },
				defaultEditor: { onAction: () => undefined },
				ui: {},
				editor: { getText: () => "", setText: (text: string) => editorText.push(text) },
				isBashMode: false,
				lastEscapeTime: 0,
				compactionQueuedMessages: [],
				clipboardQueue: { pendingClipboardImages: [], clipboardImageCounter: 0 },
				updatePendingMessagesDisplay: () => undefined,
			}) as { defaultEditor: { onEscape?: () => void } };
			setupKeyHandlers(
				(Reflect.get(InteractiveMode.prototype, "keyHandlersHost") as () => KeyHandlersHost).call(tui),
			);
			tui.defaultEditor.onEscape?.();

			expect.soft(editorText.at(-1)).toBe(`${STEERS[0]}\n\n${STEERS[1]}`);
			expect.soft(harness.session.getSteeringMessages()).toEqual([]);
			classifier.release(STEERS[1]!);
			provider.releaseFirst();
			await Promise.all([awaiting, run]);
			expect(harness.session.getSteeringMessages()).toEqual([]);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);

			harness.setResponses([
				(context) => {
					provider.requests.push(userTexts(context.messages));
					return fauxAssistantMessage("after escape");
				},
			]);
			await harness.session.prompt("next request");
			expect(provider.requests.at(-1)?.filter((text) => STEERS.includes(text))).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});
});

describe("the classification race leaves nothing attached", () => {
	for (const fails of [false, true]) {
		it(`a ${fails ? "failed" : "resolved"} classification removes its abort listener`, async () => {
			const { harness, classifier, provider, run } = await steeringHarness({ honorsAbort: false });
			const outage = heldClassifier([], { honorsAbort: false, fails });
			Reflect.set(harness.session, "_systemOneController", fails ? outage.controller : classifier.controller);
			const owner = fails ? outage : classifier;
			try {
				const pending = harness.session.steer(fails ? "outage words" : STEERS[0]!);
				if (!fails) {
					await classifier.entered(STEERS[0]!);
					classifier.release(STEERS[0]!);
				}
				await pending;
				const signal = owner.signal(fails ? "outage words" : STEERS[0]!);
				expect(signal).toBeDefined();
				expect(getEventListeners(signal!, "abort")).toHaveLength(0);
				provider.releaseFirst();
				await run;
				expect(provider.requests.at(-1)).toContain(fails ? "outage words" : STEERS[0]);
			} finally {
				harness.cleanup();
			}
		});
	}
});

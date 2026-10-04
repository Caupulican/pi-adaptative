import type { ImageContent } from "@caupulican/pi-ai";
import { type FauxResponseFactory, fauxAssistantMessage } from "@caupulican/pi-ai/faux";
import type { AssistantMessage } from "@caupulican/pi-ai/types";
import { describe, expect, it } from "vitest";
import { SessionImageStore } from "../../src/core/session-image-store.ts";
import type { PendingClipboardImage } from "../../src/modes/interactive/clipboard-input.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { type KeyHandlersHost, setupKeyHandlers } from "../../src/modes/interactive/key-handlers.ts";
import { tempDir } from "../temp-dir.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * An accepted queued owner input is delivered once, in submission order, at the active provider
 * boundary, or stays recoverable in full. Its preparation never waits for a whole unrelated turn; a
 * taken input never runs; a context change never delivers it elsewhere; disposal publishes nothing.
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
		const images = value.content
			.filter((part: { type?: string }) => part.type === "image")
			.map((part: { data?: string }) => part.data);
		return [images.length > 0 ? `${text} [images ${images.join(",")}]` : text];
	});
}

/** The first `holds` provider requests each wait for their own release; every request is captured. */
function scriptedProvider(harness: Harness, holds: number) {
	const requests: string[][] = [];
	const seen = Array.from({ length: holds }, () => deferred());
	const release = Array.from({ length: holds }, () => deferred<AssistantMessage>());
	let index = 0;
	const respond: FauxResponseFactory = (context) => {
		const current = index++;
		requests.push(userTexts(context.messages));
		if (current < holds) {
			seen[current]!.resolve();
			return release[current]!.promise;
		}
		return fauxAssistantMessage(`reply ${current}`);
	};
	harness.setResponses(Array.from({ length: holds + 10 }, () => respond));
	return {
		requests,
		seen: (n: number) => seen[n]!.promise,
		release: (n: number) => release[n]!.resolve(fauxAssistantMessage(`reply ${n}`)),
	};
}

/** Input extension holding the queued prompt submissions whose text is listed, until released. */
function heldTransforms(texts: readonly string[]) {
	const entered = new Map(texts.map((text) => [text, deferred()]));
	const release = new Map(texts.map((text) => [text, deferred()]));
	return {
		entered: (text: string) => entered.get(text)!.promise,
		release: (text: string) => release.get(text)!.resolve(),
		factory: (pi: {
			on(event: "input", handler: (event: { text: string }) => Promise<{ action: "continue" }>): void;
		}) => {
			pi.on("input", async (event) => {
				const gate = release.get(event.text);
				if (gate) {
					entered.get(event.text)!.resolve();
					await gate.promise;
				}
				return { action: "continue" };
			});
		},
	};
}

async function lifecycleHarness(held: readonly string[], holds: number) {
	const transforms = heldTransforms(held);
	const harness = await createHarness({
		settings: { modelRouter: { enabled: false } },
		extensionFactories: [
			transforms.factory as never,
			(pi) => {
				pi.on("session_before_compact", async (event) => ({
					compaction: {
						summary: "compacted",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				}));
			},
		],
	});
	harness.session.setSteeringMode("all");
	const provider = scriptedProvider(harness, holds);
	return { harness, transforms, provider };
}

const steerPrompt = (harness: Harness, text: string, images?: ImageContent[]) =>
	harness.session.prompt(text, { streamingBehavior: "steer", ...(images ? { images } : {}) });

/** The real interactive key handlers and restore path, around the real session. */
function interactiveHost(
	harness: Harness,
	editor: { text?: string; images?: PendingClipboardImage[]; store?: SessionImageStore } = {},
) {
	let text = editor.text ?? "";
	const host = Object.assign(Object.create(InteractiveMode.prototype) as object, {
		runtimeHost: { session: harness.session },
		defaultEditor: { onAction: () => undefined },
		ui: {},
		editor: {
			getText: () => text,
			setText: (value: string) => {
				text = value;
			},
		},
		isBashMode: false,
		lastEscapeTime: 0,
		compactionQueuedMessages: [],
		clipboardQueue: {
			pendingClipboardImages: [...(editor.images ?? [])],
			clipboardImageCounter: editor.images?.length ?? 0,
		},
		clipboardImageStore: editor.store,
		updatePendingMessagesDisplay: () => undefined,
	}) as {
		defaultEditor: { onEscape?: () => void; onRecallQueued?: () => boolean };
		clipboardQueue: { pendingClipboardImages: PendingClipboardImage[] };
	};
	setupKeyHandlers((Reflect.get(InteractiveMode.prototype, "keyHandlersHost") as () => KeyHandlersHost).call(host));
	const build = Reflect.get(InteractiveMode.prototype, "buildUserInputSubmission") as (
		this: object,
		value: string,
	) => { text: string; images?: ImageContent[] };
	return {
		editorText: () => text,
		pendingImages: () => host.clipboardQueue.pendingClipboardImages,
		escape: () => host.defaultEditor.onEscape?.(),
		recallQueued: () => host.defaultEditor.onRecallQueued?.(),
		/** Submit the editor's text through the interactive submission assembly, images included. */
		resubmit: async () => {
			const submission = build.call(host, text);
			text = "";
			await harness.session.prompt(submission.text, submission.images ? { images: submission.images } : {});
		},
	};
}

function firstUserEntryId(harness: Harness): string {
	const entry = harness.sessionManager
		.getEntries()
		.find((candidate) => candidate.type === "message" && candidate.message.role === "user");
	if (!entry) throw new Error("Expected a user entry.");
	return entry.id;
}

describe("queued preparation never waits for a whole unrelated turn", () => {
	it("B and C queued while A runs its own turn reach A's next provider boundary, in order", async () => {
		const { harness, transforms, provider } = await lifecycleHarness(["A words"], 2);
		try {
			const x = harness.session.prompt("X words");
			await provider.seen(0);
			const a = steerPrompt(harness, "A words");
			await transforms.entered("A words");
			provider.release(0);
			await x;
			// A is prepared only now, after X ended: it takes the foreground and runs its own turn.
			transforms.release("A words");
			await provider.seen(1);
			const b = steerPrompt(harness, "B words");
			const c = harness.session.steer("C words");
			await Promise.all([b, c]);
			expect(harness.session.getSteeringMessages()).toEqual(["B words", "C words"]);
			provider.release(1);
			await a;
			expect(provider.requests).toEqual([
				["X words"],
				["X words", "A words"],
				["X words", "A words", "B words", "C words"],
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("control: a preparation finishing after the foreground went idle runs first; the later steer follows it", async () => {
		const { harness, transforms, provider } = await lifecycleHarness(["B words"], 1);
		try {
			const x = harness.session.prompt("X words");
			await provider.seen(0);
			const b = steerPrompt(harness, "B words");
			await transforms.entered("B words");
			const c = harness.session.steer("C words");
			provider.release(0);
			await x;
			expect(provider.requests).toEqual([["X words"]]);
			transforms.release("B words");
			await Promise.all([b, c]);
			// B runs as its own turn and the steer queued behind it rides in B's first request, after it.
			expect(provider.requests).toEqual([["X words"], ["X words", "B words", "C words"]]);
			expect(harness.session.getSteeringMessages()).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});
});

describe("a taken queued input never becomes its own turn", () => {
	it("Escape after classification, during the input transform, keeps it out of every provider request", async () => {
		const { harness, transforms, provider } = await lifecycleHarness(["A words"], 1);
		const tui = interactiveHost(harness);
		try {
			const x = harness.session.prompt("X words");
			await provider.seen(0);
			const a = steerPrompt(harness, "A words");
			await transforms.entered("A words");
			tui.escape();
			expect(tui.editorText()).toBe("A words");
			provider.release(0);
			await x;
			transforms.release("A words");
			await a;
			expect(provider.requests.flat()).not.toContain("A words");
			await harness.session.prompt("after escape");
			expect(provider.requests.at(-1)).not.toContain("A words");
		} finally {
			harness.cleanup();
		}
	});

	it("control: without Escape the same input runs once as its own turn", async () => {
		const { harness, transforms, provider } = await lifecycleHarness(["A words"], 1);
		try {
			const x = harness.session.prompt("X words");
			await provider.seen(0);
			const a = steerPrompt(harness, "A words");
			await transforms.entered("A words");
			provider.release(0);
			await x;
			transforms.release("A words");
			await a;
			expect(provider.requests).toEqual([["X words"], ["X words", "A words"]]);
		} finally {
			harness.cleanup();
		}
	});
});

describe("a context change never delivers old-context input into the new branch", () => {
	it("a branch change after classification, before admission, holds the input and its follower", async () => {
		const { harness, transforms, provider } = await lifecycleHarness(["A words"], 1);
		try {
			const x = harness.session.prompt("X words");
			await provider.seen(0);
			const a = steerPrompt(harness, "A words");
			await transforms.entered("A words");
			// B's judgment supersedes A's; B is decided but waits behind A.
			const b = harness.session.steer("B words");
			await b;
			provider.release(0);
			await x;
			await harness.session.navigateTree(firstUserEntryId(harness));
			transforms.release("A words");
			await a;
			expect(provider.requests.flat()).not.toContain("A words");
			expect(provider.requests.flat()).not.toContain("B words");
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
			// Both stay recoverable, in order.
			expect(harness.session.takeQueuedMessages().steering.map((entry) => entry.text)).toEqual([
				"A words",
				"B words",
			]);
		} finally {
			harness.cleanup();
		}
	});
});

describe("recovered input keeps its complete payload", () => {
	const longText = `[Image #1] ${"long steering words ".repeat(20)}end`;
	const image: ImageContent = { type: "image", data: "aW1hZ2UtYnl0ZXM=", mimeType: "image/png" };

	it("a context-held input is recalled in full, with its image, and resubmitted once", async () => {
		const { harness, transforms, provider } = await lifecycleHarness([longText], 1);
		const tui = interactiveHost(harness);
		try {
			const x = harness.session.prompt("X words");
			await provider.seen(0);
			const a = steerPrompt(harness, longText, [image]);
			await transforms.entered(longText);
			provider.release(0);
			await x;
			await harness.session.navigateTree(firstUserEntryId(harness));
			transforms.release(longText);
			await a;
			expect(provider.requests.flat().some((text) => text.includes("long steering"))).toBe(false);

			expect(tui.recallQueued()).toBe(true);
			expect(tui.editorText()).toBe(longText);
			expect(tui.pendingImages().map((pending) => pending.content)).toEqual([image]);
			await tui.resubmit();
			const delivered = provider.requests.flat().filter((text) => text.includes("long steering"));
			expect(delivered).toEqual([`${longText} [images ${image.data}]`]);
		} finally {
			harness.cleanup();
		}
	});

	it("Escape restores queued input with its image, and resubmitting delivers it exactly once", async () => {
		const { harness, provider } = await lifecycleHarness([], 1);
		const tui = interactiveHost(harness);
		try {
			const x = harness.session.prompt("X words");
			await provider.seen(0);
			await steerPrompt(harness, longText, [image]);
			tui.escape();
			expect(tui.editorText()).toBe(longText);
			expect(tui.pendingImages().map((pending) => pending.content)).toEqual([image]);
			provider.release(0);
			await x;
			await tui.resubmit();
			const delivered = provider.requests.flat().filter((text) => text.includes("long steering"));
			expect(delivered).toEqual([`${longText} [images ${image.data}]`]);
		} finally {
			harness.cleanup();
		}
	});
});

describe("recovered images keep their durable identity", () => {
	it("Escape with the session image store restores exactly the queued and editor images, never an unrelated one", async () => {
		const { harness, provider } = await lifecycleHarness([], 1);
		const directory = tempDir("pi-lifecycle-images-");
		const store = new SessionImageStore({ agentDir: directory, cwd: directory, sessionId: "lifecycle", directory });
		const png = (words: string): ImageContent => ({
			type: "image",
			data: Buffer.from(words).toString("base64"),
			mimeType: "image/png",
		});
		store.write(Buffer.from("editor"), "image/png");
		store.write(Buffer.from("unrelated"), "image/png");
		const tui = interactiveHost(harness, {
			text: "editor [Image #1]",
			images: [{ label: "[Image #1]", content: png("editor") }],
			store,
		});
		try {
			const x = harness.session.prompt("X words");
			await provider.seen(0);
			await steerPrompt(harness, "restore [Image #1]", [png("restored")]);
			tui.escape();
			provider.release(0);
			await x;
			await tui.resubmit();
			const last = provider.requests.at(-1)?.find((text) => text.includes("restore"));
			const images = last?.match(/\[images ([^\]]*)\]/)?.[1]?.split(",");
			expect(images?.map((data) => Buffer.from(data, "base64").toString())).toEqual(["restored", "editor"]);
		} finally {
			harness.cleanup();
		}
	});
});

describe("input already handed to the agent is fenced by navigation too", () => {
	const longSteer = `[Image #1] ${"admitted steering words ".repeat(12)}end`;
	const picture: ImageContent = { type: "image", data: "c3RlZXItaW1hZ2U=", mimeType: "image/png" };

	/**
	 * After a completed turn, owner steer and follow-up are handed to the agent while it is idle, so
	 * they wait unconsumed for the next run, next to an unrelated internal steer.
	 */
	async function idleWithQueuedInput() {
		const { harness, provider } = await lifecycleHarness([], 0);
		await harness.session.prompt("X words");
		await harness.session.steer(longSteer, [picture]);
		await harness.session.followUp("admitted follow-up");
		harness.session.agent.steer({
			role: "custom",
			customType: "lifecycle-internal",
			content: "internal note",
			display: false,
			timestamp: Date.now(),
		});
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		return { harness, provider };
	}

	it("admitted steer and follow-up never enter the new branch; unrelated queued input keeps its place", async () => {
		const { harness, provider } = await idleWithQueuedInput();
		try {
			await harness.session.navigateTree(firstUserEntryId(harness));
			const before = provider.requests.length;
			await harness.session.prompt("new branch words");
			const after = provider.requests.slice(before).flat();
			expect(after.some((text) => text.includes("admitted steering"))).toBe(false);
			expect(after).not.toContain("admitted follow-up");
			expect(after).toContain("internal note");
			expect(after).toContain("new branch words");
			expect(harness.session.takeQueuedMessages()).toEqual({
				steering: [{ text: longSteer, images: [picture] }],
				followUp: [{ text: "admitted follow-up" }],
			});
		} finally {
			harness.cleanup();
		}
	});

	it("held admitted input is recalled in full with its image and delivered once on resubmit", async () => {
		const { harness, provider } = await idleWithQueuedInput();
		const tui = interactiveHost(harness);
		try {
			await harness.session.navigateTree(firstUserEntryId(harness));
			expect(tui.recallQueued()).toBe(true);
			expect(tui.editorText()).toBe(`${longSteer}\n\nadmitted follow-up`);
			expect(tui.pendingImages().map((pending) => pending.content)).toEqual([picture]);
			await tui.resubmit();
			const delivered = provider.requests.flat().filter((text) => text.includes("admitted steering"));
			expect(delivered).toEqual([`${longSteer}\n\nadmitted follow-up [images ${picture.data}]`]);
		} finally {
			harness.cleanup();
		}
	});

	it("control: without navigation the same admitted input reaches the next request once, in order", async () => {
		const { harness, provider } = await idleWithQueuedInput();
		try {
			await harness.session.prompt("same branch words");
			// Each recorded request carries the whole context, so a delivered input recurs in later
			// requests as history: "once" is per request, and delivery is its first appearance.
			const isSteer = (text: string) => text.includes("admitted steering");
			for (const request of provider.requests) expect(request.filter(isSteer).length).toBeLessThanOrEqual(1);
			const firstSteer = provider.requests.findIndex((request) => request.some(isSteer));
			expect(firstSteer).toBe(provider.requests.findIndex((request) => request.includes("same branch words")));
			const last = provider.requests.at(-1)!;
			expect(last.findIndex(isSteer)).toBeGreaterThan(-1);
			expect(last.findIndex(isSteer)).toBeLessThan(last.indexOf("admitted follow-up"));
		} finally {
			harness.cleanup();
		}
	});

	it("input accepted before any entry existed is held by navigation (no empty-leaf wildcard)", async () => {
		const { harness } = await lifecycleHarness([], 0);
		try {
			await harness.session.steer("written on an empty session");
			harness.sessionManager.appendMessage(fauxAssistantMessage("earlier entry"));
			const target = harness.sessionManager.getEntries().at(-1)!.id;
			harness.sessionManager.appendMessage(fauxAssistantMessage("later entry"));
			await harness.session.navigateTree(target);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
			expect(harness.session.getSteeringMessages()).toEqual(["written on an empty session"]);
		} finally {
			harness.cleanup();
		}
	});

	it("navigation to an ancestor also holds; an ordinary turn and a compaction do not", async () => {
		const { harness } = await lifecycleHarness([], 0);
		try {
			await harness.session.prompt("first turn");
			await harness.session.steer("queued across a compaction");
			await harness.session.compact();
			expect(harness.session.agent.hasQueuedMessages()).toBe(true);
			const ancestor = harness.sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "assistant")!.id;
			await harness.session.navigateTree(ancestor);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
			expect(harness.session.getSteeringMessages()).toEqual(["queued across a compaction"]);
		} finally {
			harness.cleanup();
		}
	});
});

describe("disposal publishes nothing", () => {
	it("a decided input waiting behind an undecided one is never handed to the agent after disposal", async () => {
		const { harness, transforms, provider } = await lifecycleHarness(["A words"], 1);
		try {
			const x = harness.session.prompt("X words");
			await provider.seen(0);
			const a = steerPrompt(harness, "A words");
			await transforms.entered("A words");
			await harness.session.steer("B words");
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
			harness.session.dispose();
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
			transforms.release("A words");
			provider.release(0);
			await Promise.allSettled([a, x]);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		} finally {
			harness.cleanup();
		}
	});
});

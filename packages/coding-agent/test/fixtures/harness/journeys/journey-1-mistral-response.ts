/** Composed Mistral transport bounds through the real SDK, provider and root-session owners. */

import { getApiProvider, registerApiProvider, unregisterApiProviders } from "@caupulican/pi-ai";
import { expect } from "vitest";
import {
	MISTRAL_RESPONSE_BOUNDS,
	streamMistral,
	streamSimpleMistral,
} from "../../../../../ai/src/providers/mistral.ts";
import { createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";

const PROVIDER = "h24-mistral";
const MODEL = "h24-model";
const BASE = "https://h24-mistral.invalid";

async function withCleanup(run: () => Promise<void>, cleanup: Array<() => void | Promise<void>>): Promise<void> {
	const failures: unknown[] = [];
	try {
		await run();
	} catch (error) {
		failures.push(error);
	}
	for (const step of cleanup) {
		try {
			await step();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, "H24 journey and cleanup failures");
}

/** Exercise actual SDK responses through the registered model and a durable user-facing root session. */
export async function runMistralResponseJourney(world: HarnessWorld): Promise<void> {
	// Real provider functions are loaded before the world installs its virtual filesystem. Its lazy
	// built-in registration would otherwise perform module I/O inside that guarded filesystem.
	registerApiProvider(
		{ api: "mistral-conversations", stream: streamMistral, streamSimple: streamSimpleMistral },
		PROVIDER,
	);
	const ownedLayer = getApiProvider("mistral-conversations");
	await withCleanup(
		() => runRegisteredMistralResponseJourney(world, ownedLayer),
		[
			() => world.modelRegistry.unregisterProvider(PROVIDER),
			() => {
				unregisterApiProviders(PROVIDER);
				const restored = getApiProvider("mistral-conversations");
				expect(restored, "the composed phase retains the underlying API owner").toBeDefined();
				expect(restored, "the composed phase removes its own API layer").not.toBe(ownedLayer);
			},
		],
	);
}

async function runRegisteredMistralResponseJourney(
	world: HarnessWorld,
	ownedLayer: ReturnType<typeof getApiProvider>,
): Promise<void> {
	const reference = world.provider.model("root");
	world.modelRegistry.registerProvider(PROVIDER, {
		api: "mistral-conversations",
		baseUrl: BASE,
		apiKey: "h24-fixture-key",
		models: [
			{
				id: MODEL,
				name: "H24 Mistral",
				reasoning: false,
				input: ["text"],
				cost: reference.cost,
				contextWindow: 32768,
				maxTokens: 2048,
			},
		],
	});
	const model = world.modelRegistry.find(PROVIDER, MODEL);
	if (!model) throw new Error("The H24 Mistral model was not registered.");
	const agentDir = `${world.agentDir}-h24-mistral`;
	const manager = world.createSessionManager(agentDir);
	const owner = await world.createRootSession("root", {
		agentDir,
		model,
		sessionManager: manager,
		settings: { retry: { enabled: false } },
	});
	const previousFetch = world.fetchResponder;
	const encoder = new TextEncoder();
	const requests: string[] = [];
	let mode: "aggregate" | "oversize" | "http" | "body" | "cancel" | "healthy" = "aggregate";
	let cancelled = 0;
	const cancelRead = createBarrier();
	const crObserved = createBarrier();
	let crObservedBeforeContinuation = false;
	const offEvents = owner.session.subscribe((event) => {
		if (
			event.type === "message_update" &&
			event.assistantMessageEvent.type === "text_delta" &&
			event.assistantMessageEvent.delta === "H24 CR frame."
		) {
			crObservedBeforeContinuation = true;
			crObserved.release();
		}
	});
	const doneFrame = (answer: string) =>
		encoder.encode(
			`data: ${JSON.stringify({ id: "h24-response", model: MODEL, choices: [{ index: 0, delta: { content: answer }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\r\n\r\n`,
		);
	world.fetchResponder = (input, init) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		if (url.origin !== BASE) return previousFetch?.(input, init);
		const request = input instanceof Request ? input : new Request(input);
		expect(request.method).toBe("POST");
		requests.push(mode);
		if (mode === "http")
			return Promise.resolve(
				new Response('{"message":"h24 upstream refusal"}', {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
			);
		if (mode === "body")
			return Promise.resolve(
				new Response("x".repeat(MISTRAL_RESPONSE_BOUNDS.bodyBytes + 1), {
					status: 400,
					headers: { "content-type": "application/json", "retry-after": "17", "x-should-retry": "false" },
				}),
			);
		const kind = mode;
		let count = 0;
		const source = new ReadableStream<Uint8Array>(
			{
				async pull(controller) {
					if (kind === "cancel") {
						if (count++ === 0) {
							controller.enqueue(encoder.encode("data: {"));
							cancelRead.release();
						}
						return;
					}
					if (kind === "oversize") {
						if (count++ === 0) controller.enqueue(encoder.encode("data: "));
						else controller.enqueue(new Uint8Array(32768).fill(120));
						return;
					}
					if (kind === "aggregate") {
						const part = count++;
						if (part === 0) {
							controller.enqueue(
								encoder.encode(
									`data: ${JSON.stringify({ id: "h24-cr", model: MODEL, choices: [{ index: 0, delta: { content: "H24 CR frame." }, finish_reason: null }] })}`,
								),
							);
							return;
						}
						if (part === 1 || part === 2) {
							controller.enqueue(encoder.encode("\r"));
							return;
						}
						if (part === 3) {
							await crObserved.promise;
							controller.enqueue(encoder.encode(":split\r"));
							return;
						}
						if (part === 4) {
							controller.enqueue(encoder.encode("\n\r"));
							return;
						}
						if (part === 5) {
							controller.enqueue(encoder.encode("\n"));
							return;
						}
						if (part === 6) {
							controller.enqueue(encoder.encode(":carry\n\n"));
							return;
						}
						if (part === 7) {
							controller.enqueue(encoder.encode(`:${"x".repeat(MISTRAL_RESPONSE_BOUNDS.frameBytes - 4)}\r\r`));
							return;
						}
						if (part === 8 || part === 9) {
							controller.enqueue(
								encoder.encode(`:${"x".repeat(MISTRAL_RESPONSE_BOUNDS.frameBytes - 5)}\r\n\r\n`),
							);
							return;
						}
						if (part < 10 + Math.ceil(MISTRAL_RESPONSE_BOUNDS.frameBytes / 262144) + 1) {
							controller.enqueue(encoder.encode(`:${"x".repeat(262140)}\r\n\r\n`));
							return;
						}
					}
					controller.enqueue(
						doneFrame(kind === "aggregate" ? "H24 aggregate accepted." : "H24 healthy response."),
					);
					controller.close();
				},
				cancel() {
					cancelled++;
				},
			},
			{ highWaterMark: 0 },
		);
		return Promise.resolve(new Response(source, { status: 200, headers: { "content-type": "text/event-stream" } }));
	};
	const expectTerminal = (outcome: "completed" | "error" | "aborted") => {
		const entries = manager.getEntries();
		const snapshots = entries.filter((entry) => entry.type === "request_snapshot" && entry.provider === PROVIDER);
		expect(snapshots).toHaveLength(requests.length);
		const current = snapshots.at(-1);
		if (current?.type !== "request_snapshot") throw new Error("The H24 physical request has no canonical snapshot.");
		const terminals = entries.filter(
			(entry) => entry.type === "provider_request_terminal" && entry.requestId === current.requestId,
		);
		expect(terminals).toHaveLength(1);
		expect(terminals[0]).toMatchObject({ outcome });
		const terminal = terminals[0];
		if (terminal?.type !== "provider_request_terminal" || !terminal.assistantMessageEntryId)
			throw new Error("The H24 request terminal lacks its assistant message identity.");
		expect(entries.find((entry) => entry.id === terminal.assistantMessageEntryId)).toMatchObject({
			type: "message",
			message: {
				role: "assistant",
				provider: PROVIDER,
				model: MODEL,
				...(outcome === "completed" ? { usage: { input: 7, output: 3, totalTokens: 10 } } : {}),
			},
		});
	};
	const run = async (next: typeof mode, prompt: string) => {
		mode = next;
		world.systemOne.enterPhase(`h24-${next}`, {});
		const before = requests.length;
		await withDeadline(world.trace, `H24 ${next} root turn`, owner.session.prompt(prompt));
		const message = owner.session.messages.at(-1);
		const diagnostic = JSON.stringify({
			model: owner.session.model && { provider: owner.session.model.provider, id: owner.session.model.id },
			assistant: message?.role === "assistant" && {
				stopReason: message.stopReason,
				error: message.errorMessage?.slice(0, 4096),
			},
			requests: manager
				.getEntries()
				.filter((entry) => entry.type === "request_snapshot" || entry.type === "provider_request_terminal")
				.map((entry) => ({
					type: entry.type,
					id: entry.id,
					requestId: entry.requestId,
					...(entry.type === "request_snapshot"
						? { provider: entry.provider, model: entry.modelId }
						: { outcome: entry.outcome }),
				})),
		});
		expect(requests.slice(before), diagnostic).toEqual([next]);
		if (message?.role !== "assistant") throw new Error(`H24 ${next} did not produce an assistant terminal.`);
		const persisted = manager
			.getBranch()
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
		expect(persisted.at(-1)).toMatchObject({
			message: { role: "assistant", stopReason: message.stopReason, provider: PROVIDER, model: MODEL },
		});
		return message;
	};
	await withCleanup(async () => {
		expect(getApiProvider("mistral-conversations"), "SDK bootstrap preserves the phase provider layer").toBe(
			ownedLayer,
		);
		const aggregate = await run("aggregate", "Report the H24 aggregate status.");
		expect(crObservedBeforeContinuation, "a CR-delimited frame is delivered before more network data").toBe(true);
		expect(aggregate.stopReason).toBe("stop");
		expectTerminal("completed");
		expect(aggregate.usage).toMatchObject({ input: 7, output: 3, totalTokens: 10 });
		expect(JSON.stringify(aggregate.content)).toContain("H24 aggregate accepted.");
		const oversized = await run("oversize", "Report the H24 oversized frame status.");
		expect(oversized.stopReason).toBe("error");
		expectTerminal("error");
		expect(oversized.errorMessage).toContain("SSE frame");
		expect(cancelled).toBeGreaterThan(0);
		const http = await run("http", "Report the H24 HTTP refusal.");
		expect(http.stopReason).toBe("error");
		expectTerminal("error");
		expect(http.errorMessage).toContain("400");
		const body = await run("body", "Report the H24 oversized HTTP body.");
		expect(body.stopReason).toBe("error");
		expectTerminal("error");
		expect(body.errorMessage).toContain("400");
		expect(body.errorMessage).toContain("retry after 17 seconds");
		expect(body.errorMessage).toContain("Provider retry directive: do not retry.");
		expect(body.errorMessage).not.toContain("x".repeat(1024));
		mode = "cancel";
		world.systemOne.enterPhase("h24-cancel", {});
		const before = requests.length;
		const turn = owner.session.prompt("Report the H24 cancelled response.");
		await withDeadline(world.trace, "H24 cancellation reaches the physical stream", cancelRead.promise);
		const beforeCancel = cancelled;
		await owner.session.abort("h24 owner cancellation");
		await withDeadline(world.trace, "H24 cancellation terminal", turn);
		await withDeadline(world.trace, "H24 cancellation releases foreground", owner.session.waitForForegroundIdle());
		expect(requests.slice(before)).toEqual(["cancel"]);
		expect(cancelled).toBeGreaterThan(beforeCancel);
		const terminal = owner.session.messages.at(-1);
		expect(terminal?.role === "assistant" && terminal.stopReason).toBe("aborted");
		expectTerminal("aborted");
		expect(
			manager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "assistant")
				.at(-1),
		).toMatchObject({ message: { stopReason: "aborted", provider: PROVIDER, model: MODEL } });
		const healthy = await run("healthy", "Report the H24 healthy status.");
		expect(healthy.stopReason).toBe("stop");
		expectTerminal("completed");
		expect(healthy.usage).toMatchObject({ input: 7, output: 3, totalTokens: 10 });
		expect(JSON.stringify(healthy.content)).toContain("H24 healthy response.");
		expect(requests).toEqual(["aggregate", "oversize", "http", "body", "cancel", "healthy"]);
		world.trace.mark("root", "h24.mistral-response-bounds");
	}, [
		() => crObserved.release(),
		() => offEvents(),
		async () => {
			expect(await world.disposeSessionInBody(owner.session)).toBeUndefined();
		},
		() => {
			world.fetchResponder = previousFetch;
		},
	]);
}

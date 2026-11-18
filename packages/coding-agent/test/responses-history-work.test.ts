import type { Context, Message } from "@caupulican/pi-ai";
import {
	acceptsReadOnlyProviderInput,
	observeHistoryWork,
	registerProviderMessagePrefix,
} from "@caupulican/pi-ai/history-work";
import { getModel } from "@caupulican/pi-ai/models";
import { createEmptyUsage } from "@caupulican/pi-ai/usage";
import { expect, it } from "vitest";
import { convertResponsesMessages } from "../../ai/src/providers/openai-responses-shared.ts";
import { BitwardenCredentialStorage } from "../src/core/secrets/bitwarden-credential-storage.ts";
import { CredentialManager } from "../src/core/secrets/credential-manager.ts";
import {
	CredentialRequestProjection,
	conditionalPayloadHook,
} from "../src/core/secrets/credential-request-projection.ts";

const model = getModel("xai", "grok-4.7-build-fast")!;
const providers = new Set(["xai"]);
const hide = (s: string) => s.replaceAll("test-secret", "[masked]");
function project() {
	const projection = new CredentialRequestProjection();
	const hook = conditionalPayloadHook(
		() => false,
		() => {
			throw new Error("Inactive hook ran");
		},
	);
	return async (messages: Message[], redact = hide) => {
		const projected = projection.prepare(model, { messages }, redact, redact, hook);
		const input = convertResponsesMessages(model, projected.context, providers, {
			reuseAcceptedPrefix: acceptsReadOnlyProviderInput(projected.onPayload),
		});
		return (await projected.onPayload!({ input }, model)) as { input: typeof input };
	};
}

it.each([100, 1_000, 10_000])(
	"retracts provisional tool output without reading any of %d old payloads",
	async (size) => {
		let armed = false;
		const row = Object.freeze({ role: "user" as const, content: "public", timestamp: 1 });
		const untouched = new Proxy(row, {
			get(target, key, receiver) {
				if (armed) throw new Error("Warm read of old row");
				return Reflect.get(target, key, receiver);
			},
			ownKeys(target) {
				if (armed) throw new Error("Warm redaction of old row");
				return Reflect.ownKeys(target);
			},
		});
		const rows: Message[] = Array(size - 1).fill(untouched);
		rows.push({
			role: "assistant",
			provider: model.provider,
			api: model.api,
			model: model.id,
			stopReason: "toolUse",
			usage: createEmptyUsage(),
			timestamp: 2,
			content: [{ type: "toolCall", name: "read", id: "call-1", arguments: {} }],
		});
		const send = project();
		Object.freeze(rows);
		registerProviderMessagePrefix(rows, undefined, 0);
		const redact = (value: string) => {
			if (armed && value === "public") throw new Error("Warm redaction of old wire input");
			return hide(value);
		};
		const before = await send(rows, redact);
		const result: Message = {
			role: "toolResult",
			toolName: "read",
			toolCallId: "call-1",
			isError: false,
			timestamp: 3,
			content: [{ type: "text", text: "actual test-secret" }],
		};
		const next = [...rows, result];
		Object.freeze(next);
		registerProviderMessagePrefix(next, rows, size);
		const work = observeHistoryWork(next);
		armed = true;
		const after = await send(next, redact);
		armed = false;
		expect(after.input[0]).toBe(before.input[0]);
		expect(Object.isFrozen(after.input[0])).toBe(true);
		expect(after.input.at(-1)).toMatchObject({ type: "function_call_output", output: "actual [masked]" });
		expect(before.input.at(-1)).not.toEqual(after.input.at(-1));
		expect(work.wireRowsConverted).toBe(1);
		expect(work.emittedRows).toBe(size + 1);
		const rebuilt = await project()(next);
		expect(JSON.stringify(after.input)).toBe(JSON.stringify(rebuilt.input));
	},
);

it("rebuilds after a credential rotation and handles competing suffixes independently", async () => {
	const send = project();
	const root: Context["messages"] = [{ role: "user", content: "newly-private", timestamp: 1 }];
	registerProviderMessagePrefix(root, undefined, 0);
	await send(root);
	const rotated = (s: string) => s.replaceAll("newly-private", "[masked]");
	for (const content of ["left", "right"]) {
		const next: Message[] = [...root, { role: "user", content, timestamp: 2 }];
		registerProviderMessagePrefix(next, root, 1);
		const result = await send(next, rotated);
		expect(JSON.stringify(result)).not.toContain("newly-private");
		expect(JSON.stringify(result)).toContain(content);
	}
});

it("reuses the exact credential scope after an interleaved tool request and drops it when locked", () => {
	const manager = new CredentialManager({
		storage: new BitwardenCredentialStorage(),
		resolveProject: async () => {
			throw new Error("Unexpected project lookup");
		},
		initialSessionKey: "fixture-session",
	});
	const a = manager.createSensitiveTextRedactor(["scope-A"]);
	manager.createSensitiveTextRedactor(["scope-B"]);
	expect(manager.createSensitiveTextRedactor(["scope-A"])).toBe(a);
	expect(a("fixture-session")).toBe("[REDACTED_SECRET]");
	manager.lock();
	const after = manager.createSensitiveTextRedactor(["scope-A"]);
	expect(after).not.toBe(a);
	expect(after("fixture-session")).toBe("fixture-session");
});

it("gives a late extension a mutable private payload and redacts its changes", async () => {
	const projection = new CredentialRequestProjection();
	let active = false;
	const hook = conditionalPayloadHook(
		() => active,
		(payload) => {
			const input = (payload as { input: { content: { text: string }[] }[] }).input;
			input[0]!.content[0]!.text = "test-secret";
		},
	);
	const source: Message[] = [{ role: "user", content: "unchanged", timestamp: 1 }];
	registerProviderMessagePrefix(source, undefined, 0);
	const prepared = projection.prepare(model, { messages: source }, hide, hide, hook);
	const input = convertResponsesMessages(model, prepared.context, providers, { reuseAcceptedPrefix: true });
	active = true;
	const safe = await prepared.onPayload!({ input }, model);
	expect(JSON.stringify(safe)).toContain("[masked]");
	expect(JSON.stringify(input)).toContain("unchanged");
});

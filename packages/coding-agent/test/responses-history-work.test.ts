import type { Context, Message, Model } from "@caupulican/pi-ai";
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
const codexModel: Model<"openai-codex-responses"> = {
	api: "openai-codex-responses",
	provider: "openai-codex",
	id: "fixture-codex",
	name: "Fixture Codex",
	baseUrl: "https://unused.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 100_000,
	maxTokens: 1_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
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

it("masks quoted passwords in a historical tool result while retaining the original record", () => {
	const row: Message = {
		role: "toolResult",
		toolName: "python",
		toolCallId: "prior-call",
		isError: false,
		timestamp: 1,
		content: [{ type: "text", text: "legacy sudo password 'example phrase'; unrelated row" }],
		details: {
			preview: "passphrase is 'example phrase'",
			nested: { password: "example phrase" },
			json: '{"password":"example phrase","key":"public identifier"}',
		},
	};
	const user: Message = {
		role: "user",
		timestamp: 0,
		content: 'Search for the source expression password = "example phrase".',
	};
	const code: Message = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: 0,
		stopReason: "toolUse",
		usage: createEmptyUsage(),
		content: [
			{ type: "toolCall", name: "python", id: "prior-call", arguments: { code: 'password = "example phrase"' } },
		],
	};
	const context = new CredentialRequestProjection().prepare(
		model,
		{ messages: [row, user, code] },
		hide,
		hide,
	).context;
	expect(context.messages[1]).toBe(user);
	expect(context.messages[2]).toBe(code);
	expect(context.messages[0]).toMatchObject({
		content: [{ text: "legacy sudo [REDACTED]; unrelated row" }],
		details: {
			preview: "[REDACTED]",
			nested: { password: "<mocked:password>" },
			json: '{"password":"<mocked:password>","key":"public identifier"}',
		},
	});
	expect(row.content[0]).toMatchObject({ text: expect.stringContaining("example phrase") });
});

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

it.each([model, codexModel])(
	"gives a late extension a mutable private payload and redacts its changes on $api",
	async (requestModel) => {
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
		const prepared = projection.prepare(requestModel, { messages: source }, hide, hide, hook);
		const input = convertResponsesMessages(requestModel, prepared.context, providers, { reuseAcceptedPrefix: true });
		active = true;
		const safe = await prepared.onPayload!({ input }, requestModel);
		expect(JSON.stringify(safe)).toContain("[masked]");
		expect(JSON.stringify(input)).toContain("unchanged");
	},
);

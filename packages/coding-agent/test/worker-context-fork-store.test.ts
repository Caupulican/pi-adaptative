import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Usage, UserMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { workerContextForkFile } from "../src/core/agent-paths.ts";
import type { SanitizedContextForkMessage } from "../src/core/delegation/sanitized-context-fork.ts";
import {
	MAX_RETAINED_WORKER_CONTEXT_FORK_SNAPSHOTS,
	WorkerContextForkStore,
	WorkerContextForkStoreError,
} from "../src/core/delegation/worker-context-fork-store.ts";
import {
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	MAX_ORCHESTRATION_MODEL_ID_LENGTH,
	MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH,
} from "../src/core/orchestration/contracts.ts";
import {
	MAX_WORKER_CONTEXT_FORK_API_LENGTH,
	MAX_WORKER_CONTEXT_FORK_BYTES,
	MAX_WORKER_CONTEXT_FORK_MESSAGES,
	MAX_WORKER_CONTEXT_FORK_TEXT_BLOCKS,
} from "../src/core/orchestration/worker-context-fork-reference.ts";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeStore(parentSessionId = "parent-session"): { agentDir: string; store: WorkerContextForkStore } {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-context-fork-store-"));
	tempDirectories.push(agentDir);
	return { agentDir, store: new WorkerContextForkStore({ agentDir, parentSessionId }) };
}

function user(text: string, timestamp = 1): UserMessage {
	return { role: "user", content: text, timestamp };
}

function assistant(
	text: string,
	timestamp = 2,
	identity: Partial<Pick<AssistantMessage, "api" | "provider" | "model">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: identity.api ?? "openai-responses",
		provider: identity.provider ?? "openai",
		model: identity.model ?? "test-model",
		usage: structuredClone(ZERO_USAGE),
		stopReason: "stop",
		timestamp,
	};
}

function snapshotFile(
	agentDir: string,
	parentSessionId: string,
	reference: { identityDigest: string; contentDigest: string },
): string {
	return workerContextForkFile(agentDir, parentSessionId, reference.identityDigest, reference.contentDigest);
}

function expectStoreCode(fn: () => unknown, code: WorkerContextForkStoreError["code"]): void {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(WorkerContextForkStoreError);
		expect((error as WorkerContextForkStoreError).code).toBe(code);
		return;
	}
	throw new Error(`Expected WorkerContextForkStoreError '${code}'.`);
}

describe("WorkerContextForkStore", () => {
	it("atomically captures and reopens one exact canonical sanitized snapshot", () => {
		const { agentDir, store } = makeStore();
		const messages: SanitizedContextForkMessage[] = [user("request"), assistant("answer")];
		const expectedMessages = structuredClone(messages);

		const reference = store.capture({ logicalAgentId: "reviewer", messages });
		const filePath = snapshotFile(agentDir, "parent-session", reference);
		const raw = readFileSync(filePath, "utf-8");
		const inode = statSync(filePath).ino;
		const reopened = store.open({ logicalAgentId: "reviewer", reference });

		expect(raw.endsWith("\n")).toBe(true);
		expect(reference.messageCount).toBe(2);
		expect(reference.messageBytes).toBe(Buffer.byteLength(JSON.stringify(messages), "utf-8"));
		expect(reopened.messages).toEqual(expectedMessages);
		expect(reopened.messages).not.toBe(messages);
		expect(statSync(filePath).mode & 0o777).toBe(0o600);
		expect(readdirSync(join(filePath, ".."))).not.toEqual(expect.arrayContaining([expect.stringMatching(/\.tmp$/)]));

		messages[0]!.content = "mutated caller copy";
		reopened.messages[0]!.content = "mutated reopened copy";
		expect(store.open({ logicalAgentId: "reviewer", reference }).messages).toEqual(expectedMessages);

		const replayed = store.capture({ logicalAgentId: "reviewer", messages: expectedMessages });
		expect(replayed).toEqual(reference);
		expect(statSync(filePath).ino).toBe(inode);
		expect(readFileSync(filePath, "utf-8")).toBe(raw);
	});

	it("uses the content digest across identities but rejects conflicting reuse of one logical agent", () => {
		const { agentDir, store } = makeStore();
		const messages = [user("same inherited context")];
		const first = store.capture({ logicalAgentId: "worker-a", messages });
		const second = store.capture({ logicalAgentId: "worker-b", messages });

		expect(second.contentDigest).toBe(first.contentDigest);
		expect(second.identityDigest).not.toBe(first.identityDigest);
		expectStoreCode(
			() => store.capture({ logicalAgentId: "worker-a", messages: [user("different inherited context")] }),
			"identity_conflict",
		);
		expect(readdirSync(join(snapshotFile(agentDir, "parent-session", first), ".."))).toHaveLength(2);
	});

	it("rejects a reference for another identity and detects payload, schema, and size corruption", () => {
		const { agentDir, store } = makeStore();
		const reference = store.capture({ logicalAgentId: "worker", messages: [user("trusted snapshot")] });
		const filePath = snapshotFile(agentDir, "parent-session", reference);

		expectStoreCode(() => store.open({ logicalAgentId: "other-worker", reference }), "identity_conflict");

		const envelope = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
		envelope.messages = [user("tampered snapshot")];
		writeFileSync(filePath, `${JSON.stringify(envelope)}\n`, "utf-8");
		const corruptRaw = readFileSync(filePath, "utf-8");
		expectStoreCode(() => store.open({ logicalAgentId: "worker", reference }), "snapshot_corrupt");
		expectStoreCode(
			() => store.capture({ logicalAgentId: "worker", messages: [user("trusted snapshot")] }),
			"snapshot_corrupt",
		);
		expect(readFileSync(filePath, "utf-8")).toBe(corruptRaw);

		const schemaFixture = makeStore("schema-parent");
		const schemaReference = schemaFixture.store.capture({ logicalAgentId: "worker", messages: [user("snapshot")] });
		const schemaPath = snapshotFile(schemaFixture.agentDir, "schema-parent", schemaReference);
		const schemaEnvelope = JSON.parse(readFileSync(schemaPath, "utf-8")) as Record<string, unknown>;
		schemaEnvelope.schemaVersion = 2;
		writeFileSync(schemaPath, `${JSON.stringify(schemaEnvelope)}\n`, "utf-8");
		expectStoreCode(
			() => schemaFixture.store.open({ logicalAgentId: "worker", reference: schemaReference }),
			"snapshot_corrupt",
		);

		const sizeFixture = makeStore("size-parent");
		const sizeReference = sizeFixture.store.capture({ logicalAgentId: "worker", messages: [user("snapshot")] });
		const sizePath = snapshotFile(sizeFixture.agentDir, "size-parent", sizeReference);
		writeFileSync(sizePath, "x".repeat(MAX_WORKER_CONTEXT_FORK_BYTES * 2), "utf-8");
		expectStoreCode(
			() => sizeFixture.store.open({ logicalAgentId: "worker", reference: sizeReference }),
			"snapshot_corrupt",
		);
	});

	it("rejects missing files, malformed references, and duplicate-key noncanonical payloads", () => {
		const missingFixture = makeStore("missing-parent");
		const missingReference = missingFixture.store.capture({
			logicalAgentId: "worker",
			messages: [user("snapshot")],
		});
		const missingPath = snapshotFile(missingFixture.agentDir, "missing-parent", missingReference);
		rmSync(missingPath);
		expectStoreCode(
			() => missingFixture.store.open({ logicalAgentId: "worker", reference: missingReference }),
			"snapshot_missing",
		);

		const malformedReference = { ...missingReference, extra: true } as typeof missingReference;
		expectStoreCode(
			() => missingFixture.store.open({ logicalAgentId: "worker", reference: malformedReference }),
			"snapshot_corrupt",
		);

		const duplicateFixture = makeStore("duplicate-parent");
		const duplicateReference = duplicateFixture.store.capture({
			logicalAgentId: "worker",
			messages: [user("snapshot")],
		});
		const duplicatePath = snapshotFile(duplicateFixture.agentDir, "duplicate-parent", duplicateReference);
		const canonical = readFileSync(duplicatePath, "utf-8");
		writeFileSync(duplicatePath, `{"schemaVersion":1,${canonical.slice(1)}`, "utf-8");
		expectStoreCode(
			() => duplicateFixture.store.open({ logicalAgentId: "worker", reference: duplicateReference }),
			"snapshot_corrupt",
		);
	});

	it("rejects malformed, structurally excessive, and oversized capture input before persistence", () => {
		const { agentDir, store } = makeStore();
		const toolBearing = [
			{
				...assistant("unsafe"),
				content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
			},
		] as unknown as SanitizedContextForkMessage[];
		const tooMany = Array.from({ length: MAX_WORKER_CONTEXT_FORK_MESSAGES + 1 }, (_, index) =>
			user(`turn ${index}`, index),
		);
		const oversized = [user("x".repeat(MAX_WORKER_CONTEXT_FORK_BYTES))];

		expect(() => store.capture({ logicalAgentId: "tools", messages: toolBearing })).toThrow(TypeError);
		expect(() => store.capture({ logicalAgentId: "many", messages: tooMany })).toThrow(TypeError);
		expect(() => store.capture({ logicalAgentId: "large", messages: oversized })).toThrow(TypeError);
		expect(readdirSync(agentDir)).toEqual([]);
	});

	it("enforces one aggregate text-block ceiling across the complete snapshot", () => {
		const { store } = makeStore();
		const blocks = (count: number, prefix: string) =>
			Array.from({ length: count }, (_, index) => ({ type: "text" as const, text: `${prefix}-${index}` }));
		const atLimit: SanitizedContextForkMessage[] = [
			{ role: "user", content: blocks(MAX_WORKER_CONTEXT_FORK_TEXT_BLOCKS / 2, "first"), timestamp: 1 },
			{ role: "user", content: blocks(MAX_WORKER_CONTEXT_FORK_TEXT_BLOCKS / 2, "second"), timestamp: 2 },
		];
		const overLimit: SanitizedContextForkMessage[] = [
			...atLimit,
			{ role: "user", content: [{ type: "text", text: "overflow" }], timestamp: 3 },
		];

		expect(store.capture({ logicalAgentId: "at-block-limit", messages: atLimit }).messageCount).toBe(2);
		expect(() => store.capture({ logicalAgentId: "over-block-limit", messages: overLimit })).toThrow(TypeError);
	});

	it("applies distinct session, agent, API, provider, and model identity bounds", () => {
		const parentAtLimit = "p".repeat(MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
		const { store } = makeStore(parentAtLimit);
		const agentAtLimit = "a".repeat(MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
		const boundaryAssistant = assistant("answer", 2, {
			api: "i".repeat(MAX_WORKER_CONTEXT_FORK_API_LENGTH),
			provider: "p".repeat(MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH),
			model: "m".repeat(MAX_ORCHESTRATION_MODEL_ID_LENGTH),
		});

		expect(
			store.capture({ logicalAgentId: agentAtLimit, messages: [user("request"), boundaryAssistant] }),
		).toBeDefined();
		expect(() => makeStore("p".repeat(MAX_ORCHESTRATION_IDENTIFIER_LENGTH + 1))).toThrow(TypeError);
		expect(() =>
			store.capture({
				logicalAgentId: "a".repeat(MAX_ORCHESTRATION_IDENTIFIER_LENGTH + 1),
				messages: [user("request")],
			}),
		).toThrow(TypeError);
		expect(() =>
			store.capture({
				logicalAgentId: "api-over-limit",
				messages: [
					user("request"),
					assistant("answer", 2, { api: "i".repeat(MAX_WORKER_CONTEXT_FORK_API_LENGTH + 1) }),
				],
			}),
		).toThrow(TypeError);
		expect(() =>
			store.capture({
				logicalAgentId: "provider-over-limit",
				messages: [
					user("request"),
					assistant("answer", 2, { provider: "p".repeat(MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH + 1) }),
				],
			}),
		).toThrow(TypeError);
		expect(() =>
			store.capture({
				logicalAgentId: "model-over-limit",
				messages: [
					user("request"),
					assistant("answer", 2, { model: "m".repeat(MAX_ORCHESTRATION_MODEL_ID_LENGTH + 1) }),
				],
			}),
		).toThrow(TypeError);
	});

	it("caps retained immutable snapshots at the worker fleet ceiling while allowing exact replay", () => {
		const { agentDir, store } = makeStore();
		let firstReference: ReturnType<WorkerContextForkStore["capture"]> | undefined;
		for (let index = 0; index < MAX_RETAINED_WORKER_CONTEXT_FORK_SNAPSHOTS; index += 1) {
			const reference = store.capture({ logicalAgentId: `worker-${index}`, messages: [user(`turn ${index}`)] });
			if (index === 0) firstReference = reference;
		}

		expectStoreCode(
			() => store.capture({ logicalAgentId: "one-too-many", messages: [user("overflow")] }),
			"capacity_reached",
		);
		expect(store.capture({ logicalAgentId: "worker-0", messages: [user("turn 0")] })).toEqual(firstReference);
		const snapshotDirectory = join(snapshotFile(agentDir, "parent-session", firstReference!), "..");
		expect(readdirSync(snapshotDirectory).filter((name) => name.endsWith(".json"))).toHaveLength(
			MAX_RETAINED_WORKER_CONTEXT_FORK_SNAPSHOTS,
		);
	});
});

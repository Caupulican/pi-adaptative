import { describe, expect, it } from "vitest";
import {
	BrainCurator,
	type CurationComplete,
	parseCurationDigest,
	parseCurationRelevance,
	preDigestConversationText,
} from "../src/core/context/brain-curator.ts";
import { createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";
import { runContextAudit } from "../src/core/context/context-audit.ts";
import {
	type ContextPromptEnforcementSettings,
	enforcePromptPolicy,
} from "../src/core/context/context-prompt-enforcement.ts";
import { planPromptPolicy } from "../src/core/context/context-prompt-policy.ts";
import { applyContextGc, type ContextGcPackedRecord } from "../src/core/context-gc.ts";
import { wrapUntrustedText } from "../src/core/security/untrusted-boundary.ts";
import { createHarness } from "./test-harness.ts";

const scripted = (replies: string[]): CurationComplete => {
	let call = 0;
	return async () => ({ text: replies[call++] ?? "", costUsd: 0, stopReason: "stop" });
};

describe("BrainCurator queue and results", () => {
	it("is idempotent on key and drops the oldest job beyond the queue cap (counted, not silent)", async () => {
		const curator = new BrainCurator();
		for (let i = 0; i < 40; i++) {
			curator.enqueue({ kind: "stub_digest", key: `k-${i}`, content: `chunk ${i}` });
			curator.enqueue({ kind: "stub_digest", key: `k-${i}`, content: "duplicate ignored" });
		}
		const telemetry = curator.telemetry();
		expect(telemetry.queued).toBe(32);
		expect(telemetry.droppedJobs).toBe(8);
	});

	it("drains digest jobs, stores parsed results, and never retries a failed key", async () => {
		const curator = new BrainCurator();
		curator.enqueue({ kind: "stub_digest", key: "good", content: "grep output about retryWithJitter" });
		curator.enqueue({ kind: "stub_digest", key: "bad", content: "unparseable reply coming" });

		const results = await curator.drain({
			maxJobs: 10,
			complete: scripted(['{"digest":"retryWithJitter found in src/http/client.ts"}', "no json here"]),
		});

		expect(results.map((result) => result.ok)).toEqual([true, false]);
		// getDigest returns the digest already fenced in the untrusted-content boundary (wrapped once,
		// here at drain time) — never bare model prose (design: untrusted-content-boundary).
		const digest = curator.getDigest("good");
		expect(digest).toContain("retryWithJitter found in src/http/client.ts");
		expect(digest).toContain("<untrusted_content");
		expect(digest).toContain("context-gc:auto-digest");
		// Fixed at store time: repeated reads return the exact same fenced bytes (stable nonce), so a
		// GC stub built from this digest is byte-identical across every render (BUG E regression).
		expect(curator.getDigest("good")).toBe(digest);
		expect(curator.getDigest("bad")).toBeUndefined();
		expect(curator.telemetry()).toMatchObject({ jobsRun: 2, parseFailures: 1, queued: 0, digestsServed: 0 });
		curator.noteDigestServed();
		expect(curator.telemetry().digestsServed).toBe(1);

		// The failed key holds a not-ok result: re-enqueueing is a no-op, not an infinite retry.
		curator.enqueue({ kind: "stub_digest", key: "bad", content: "again" });
		expect(curator.telemetry().queued).toBe(0);
	});

	it("drains relevance jobs and exposes verdicts only for parsed results", async () => {
		const curator = new BrainCurator();
		curator.enqueue({ kind: "relevance", key: "item-1", content: "old grep output", goal: "ship the release" });
		await curator.drain({ maxJobs: 5, complete: scripted(['{"relevant":false,"confidence":0.92}']) });
		expect(curator.getRelevance("item-1")).toEqual({ relevant: false, confidence: 0.92 });
		expect(curator.getDigest("item-1")).toBeUndefined();
	});

	it("respects maxJobs and leaves the remainder queued", async () => {
		const curator = new BrainCurator();
		curator.enqueue({ kind: "stub_digest", key: "a", content: "a" });
		curator.enqueue({ kind: "stub_digest", key: "b", content: "b" });
		curator.enqueue({ kind: "stub_digest", key: "c", content: "c" });
		const results = await curator.drain({ maxJobs: 2, complete: scripted(['{"digest":"a"}', '{"digest":"b"}']) });
		expect(results).toHaveLength(2);
		expect(curator.telemetry().queued).toBe(1);
	});
});

describe("curation parsers", () => {
	it("rejects oversized, empty, and non-JSON digests", () => {
		expect(parseCurationDigest('{"digest":"ok fact"}')).toBe("ok fact");
		expect(parseCurationDigest(`{"digest":"${"y".repeat(300)}"}`)).toBeUndefined();
		expect(parseCurationDigest('{"digest":"  "}')).toBeUndefined();
		expect(parseCurationDigest("plain prose")).toBeUndefined();
	});

	it("clamps relevance confidence into [0,1] and requires a boolean verdict", () => {
		expect(parseCurationRelevance('{"relevant":false,"confidence":7}')).toEqual({ relevant: false, confidence: 1 });
		expect(parseCurationRelevance('{"relevant":"nope"}')).toBeUndefined();
		expect(parseCurationRelevance('{"relevant":true}')).toEqual({ relevant: true, confidence: 0 });
	});
});

describe("context-gc curation hooks (surface 2: stub digests)", () => {
	const bigToolResult = (toolCallId: string) => ({
		role: "toolResult" as const,
		toolCallId,
		toolName: "grep",
		content: [{ type: "text" as const, text: `nonce-fact-${toolCallId} ${"z".repeat(2000)}` }],
		isError: false,
		timestamp: 0,
	});
	const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 0 });
	const gcSettings = { cwd: "/repo", preserveRecentMessages: 2, minToolResultChars: 100, writePayloads: false };

	it("onPacked receives the exact original text and the record's stable digest key", () => {
		const packed: Array<{ record: ContextGcPackedRecord; original: string }> = [];
		const messages = [bigToolResult("tc-1"), user("a"), user("b"), user("c")];
		applyContextGc(messages, {
			...gcSettings,
			curation: { onPacked: (record, originalText) => packed.push({ record, original: originalText }) },
		});
		expect(packed).toHaveLength(1);
		expect(packed[0]!.original).toContain("nonce-fact-tc-1");
		expect(packed[0]!.record.key).toBeDefined();
	});

	it("renders a resolved digest inside the stub verbatim; an absent digest leaves the stub unchanged", () => {
		const messages = [bigToolResult("tc-1"), user("a"), user("b"), user("c")];
		const first = applyContextGc(messages, gcSettings);
		const firstText = JSON.stringify(first.messages[0]);
		expect(firstText).not.toContain("summary:");

		const key = first.report.records[0]!.key!;
		// In production resolveDigest is backed by BrainCurator.getDigest, which returns the digest
		// already fenced (wrapped exactly once, at store time — see the byte-stability test below).
		// Mirror that contract here instead of handing context-gc a bare, unfenced string.
		const fenced = wrapUntrustedText("grep hit for nonce-fact-tc-1", "context-gc:auto-digest");
		const second = applyContextGc(messages, {
			...gcSettings,
			curation: { resolveDigest: (digestKey) => (digestKey === key ? fenced : undefined) },
		});
		const secondText = JSON.stringify(second.messages[0]);
		// The digest is derived from (attacker-influenceable) tool output, so it must be rendered inside
		// the standard untrusted-content fence — like memory recall pages — not inlined as bare prose.
		expect(secondText).toContain("machine paraphrase, not authoritative):");
		expect(secondText).toContain("untrusted_content");
		expect(secondText).toContain("context-gc:auto-digest");
		expect(secondText).toContain("grep hit for nonce-fact-tc-1");
		// The stored record holds exactly what resolveDigest returned (already fenced).
		expect(second.report.records[0]!.digest).toBe(fenced);
		// context-gc must render it VERBATIM — re-wrapping an already-fenced digest would nest
		// boundaries (and, worse, defeat the fixed store-time nonce checked below).
		expect(secondText.match(/<untrusted_content/g)).toHaveLength(1);
		// A re-wrap would also neutralize (HTML-escape) the inner fence's tags as spoofing attempts,
		// corrupting the digest bytes even where the outer tag count still looks like 1. Assert the
		// exact pre-fenced text survives byte-for-byte.
		expect(secondText).toContain(JSON.stringify(fenced).slice(1, -1));
	});

	it("BUG E regression: a digest resolved from BrainCurator renders byte-identically across repeated GC passes", async () => {
		// context-gc re-executes from raw messages on EVERY provider request. If resolveDigest's
		// result were re-fenced with a fresh nonce on each render, the packed stub — and the whole
		// prompt prefix after it — would be byte-different on every request, busting prompt caching.
		// The fence's nonce must be fixed once, at the point the curator STORES the digest.
		const curator = new BrainCurator();
		const messages = [bigToolResult("tc-1"), user("a"), user("b"), user("c")];
		// First pass: pack and enqueue the digest job, exactly like a real per-turn GC pass would.
		applyContextGc(messages, {
			...gcSettings,
			curation: {
				onPacked: (record) => curator.enqueue({ kind: "stub_digest", key: record.key!, content: "chunk" }),
			},
		});
		await curator.drain({
			maxJobs: 1,
			complete: scripted(['{"digest":"retryWithJitter found in src/http/client.ts"}']),
		});

		const resolveDigest = (digestKey: string) => curator.getDigest(digestKey);
		const first = applyContextGc(messages, { ...gcSettings, curation: { resolveDigest } });
		const second = applyContextGc(messages, { ...gcSettings, curation: { resolveDigest } });
		const firstText = JSON.stringify(first.messages[0]);
		const secondText = JSON.stringify(second.messages[0]);

		expect(firstText).toContain("retryWithJitter found in src/http/client.ts");
		expect(firstText).toBe(secondText);
		// Fenced exactly once — no nested boundary from a re-wrap at render time.
		expect(firstText.match(/<untrusted_content/g)).toHaveLength(1);
		expect(firstText.match(/<\/untrusted_content/g)).toHaveLength(1);
	});
});

describe("enforcement advisory lever (surface 1: relevance)", () => {
	const BIG = "x".repeat(20_000);

	function eligibleWorld() {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write({
			kind: "tool_output",
			content: BIG,
			toolName: "grep",
			createdAtTurn: 0,
			reproducible: true,
		});
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: "tc-1",
			toolName: "grep",
			content: [{ type: "text" as const, text: BIG }],
			details: { artifactId: ref.id },
			isError: false,
			timestamp: 0,
		};
		const user = (text: string) => ({
			role: "user" as const,
			content: [{ type: "text" as const, text }],
			timestamp: 0,
		});
		// 6 messages; the tool result at index 0 is INSIDE preserveRecentMessages: 20 (the recent
		// window) but OUTSIDE the absolute floor of 4 (indexes 2..5).
		const messages = [toolResult, user("a"), user("b"), user("c"), user("d"), user("e")];
		const audit = runContextAudit(messages, { turnIndex: 0, artifactStore: store });
		const plan = planPromptPolicy(audit);
		return { messages, plan };
	}

	const baseSettings: ContextPromptEnforcementSettings = {
		enabled: true,
		preserveRecentMessages: 20,
		minChars: 10,
		retrievalToolAvailable: true,
	};

	it("keeps the item without an advisory (recent window respected byte-for-byte)", () => {
		const { messages, plan } = eligibleWorld();
		const result = enforcePromptPolicy(messages, plan, baseSettings);
		expect(result.messages).toBe(messages);
		expect(result.report.items.every((item) => item.skipReason === "within_recent_window")).toBe(true);
	});

	it("evicts on an explicit high-confidence irrelevance verdict, and reports the advisory", () => {
		const { messages, plan } = eligibleWorld();
		const result = enforcePromptPolicy(messages, plan, {
			...baseSettings,
			brainRelevance: () => ({ relevant: false, confidence: 0.9 }),
		});
		const enforced = result.report.items.filter((item) => item.enforced);
		expect(enforced).toHaveLength(1);
		expect(enforced[0]!.advisory).toBe("brain_irrelevant");
		expect(JSON.stringify(result.messages[0])).toContain("artifact_retrieve");
	});

	it("never evicts on relevant or low-confidence verdicts", () => {
		const { messages, plan } = eligibleWorld();
		for (const verdict of [
			{ relevant: true, confidence: 0.99 },
			{ relevant: false, confidence: 0.5 },
		]) {
			const result = enforcePromptPolicy(messages, plan, { ...baseSettings, brainRelevance: () => verdict });
			expect(result.messages).toBe(messages);
		}
	});

	it("never evicts inside the absolute floor (last 4 messages) even on a confident verdict", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write({
			kind: "tool_output",
			content: BIG,
			toolName: "grep",
			createdAtTurn: 0,
			reproducible: true,
		});
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: "tc-1",
			toolName: "grep",
			content: [{ type: "text" as const, text: BIG }],
			details: { artifactId: ref.id },
			isError: false,
			timestamp: 0,
		};
		const user = { role: "user" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: 0 };
		const messages = [user, toolResult, user]; // tool result is within the last 4 messages
		const audit = runContextAudit(messages, { turnIndex: 0, artifactStore: store });
		const plan = planPromptPolicy(audit);
		const result = enforcePromptPolicy(messages, plan, {
			...baseSettings,
			brainRelevance: () => ({ relevant: false, confidence: 0.99 }),
		});
		expect(result.messages).toBe(messages);
	});
});

describe("session drain gate (fail-closed)", () => {
	it("refuses to drain without a model, and refuses unprobed models — with visible reasons", () => {
		const harness = createHarness();
		try {
			const session = harness.session as unknown as {
				settingsManager: { setContextCurationSettings: (s: object) => void };
				// _brainCurator moved to ContextPipeline (god-file decomposition); _maybeDrainBrainCuration +
				// getContextCurationStatus stay on AgentSession as one-line delegations to the pipeline.
				_pipeline: { _brainCurator: { enqueue: (job: object) => void } };
				_maybeDrainBrainCuration: () => void;
				getContextCurationStatus: () => { lastSkipReason?: string; telemetry: { jobsRun: number } };
			};
			session.settingsManager.setContextCurationSettings({ enabled: true });
			session._pipeline._brainCurator.enqueue({ kind: "stub_digest", key: "k1", content: "chunk" });
			session._maybeDrainBrainCuration();
			expect(session.getContextCurationStatus().lastSkipReason).toBe("curation_model_unset");
			expect(session.getContextCurationStatus().telemetry.jobsRun).toBe(0);

			session.settingsManager.setContextCurationSettings({ enabled: true, model: "definitely/not-probed" });
			session._maybeDrainBrainCuration();
			const status = session.getContextCurationStatus();
			expect(["curation_model_unresolved", "curation_model_unprobed"]).toContain(status.lastSkipReason);
			expect(status.telemetry.jobsRun).toBe(0);
		} finally {
			harness.cleanup();
		}
	});
});

describe("compaction pre-digest (surface 3)", () => {
	it("leaves short conversations untouched (no local calls)", async () => {
		let calls = 0;
		const result = await preDigestConversationText({
			text: "short conversation",
			complete: async () => {
				calls++;
				return { text: "{}", costUsd: 0, stopReason: "stop" };
			},
		});
		expect(result).toEqual({ text: "short conversation", totalChunks: 0, digested: 0, failed: 0 });
		expect(calls).toBe(0);
	});

	it("digests old chunks, keeps the recent tail verbatim, and passes failed chunks through", async () => {
		const chunkA = "A".repeat(1000);
		const chunkB = `the-nonce-fact ${"B".repeat(984)}`;
		const tail = "TAIL".repeat(100); // 400 chars kept verbatim
		const text = chunkA + chunkB + tail;
		let call = 0;
		const replies = ['{"digest":"chunk A said nothing durable"}', "not json"];
		const result = await preDigestConversationText({
			text,
			chunkChars: 1000,
			keepRecentChars: 400,
			complete: async () => ({ text: replies[call++] ?? "", costUsd: 0, stopReason: "stop" }),
		});
		expect(result.totalChunks).toBe(2);
		expect(result.digested).toBe(1);
		expect(result.failed).toBe(1);
		expect(result.text).toContain("locally pre-digested chunk 1/2");
		expect(result.text).toContain("chunk A said nothing durable");
		// failed chunk passes VERBATIM — partial assist, never partial loss
		expect(result.text).toContain("the-nonce-fact");
		expect(result.text.endsWith(tail)).toBe(true);
		expect(result.text.length).toBeLessThan(text.length);
	});
});

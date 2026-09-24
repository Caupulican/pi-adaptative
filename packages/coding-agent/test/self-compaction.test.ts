import {
	DEFAULT_COMPACTION_SETTINGS,
	hardCompactionTriggerTokens,
} from "@caupulican/pi-agent-core/compaction/compaction";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import type { SessionEntry } from "@caupulican/pi-agent-core/session";
import { describe, expect, it } from "vitest";
import {
	applySelfCompactionEntry,
	DEFAULT_SELF_COMPACTION_SETTINGS,
	deriveSelfCompactionState,
	renderSelfCompactionTemplate,
	resolveSelfCompactionSettings,
	resolveSelfCompactionThresholds,
	SELF_COMPACTION_ABANDONED_CUSTOM_TYPE,
	SELF_COMPACTION_HANDOFF_CUSTOM_TYPE,
	SELF_COMPACTION_NOTE_MAX_CHARS,
	SELF_COMPACTION_OWNER_REQUEST_CUSTOM_TYPE,
	SELF_COMPACTION_PROMPT_MAX_CHARS,
	SELF_COMPACTION_REQUEST_CUSTOM_TYPE,
	SelfCompactionStateScan,
	selfCompactionGuidance,
	selfCompactionLevel,
	selfCompactionTemplateValues,
	validateSelfCompactionNote,
} from "../src/core/compaction/self-compaction.ts";
import { resolveSessionEntryIndex } from "../src/core/session-entry-index.ts";

function thresholdsFor(contextWindow: number) {
	const hard = hardCompactionTriggerTokens(contextWindow, DEFAULT_COMPACTION_SETTINGS);
	const early = Math.floor(contextWindow * (DEFAULT_COMPACTION_SETTINGS.triggerPercent ?? 0));
	return resolveSelfCompactionThresholds(contextWindow, hard, early, DEFAULT_SELF_COMPACTION_SETTINGS)!;
}

function assistant(stopReason: "stop" | "aborted" | "error" = "stop") {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "ok" }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function request(manager: SessionManager, id: string, note = `note ${id}`): void {
	manager.appendCustomEntry(SELF_COMPACTION_REQUEST_CUSTOM_TYPE, {
		id,
		note,
		requestedAt: new Date().toISOString(),
		level: "warning",
		tokens: 100,
	});
}

describe("self-compaction settings", () => {
	it("uses safe defaults and accepts ordered fractions", () => {
		expect(resolveSelfCompactionSettings({})).toEqual(DEFAULT_SELF_COMPACTION_SETTINGS);
		expect(resolveSelfCompactionSettings({ notice: 0.5, warning: 0.6, forced: 0.9 })).toEqual({
			enabled: true,
			notice: 0.5,
			warning: 0.6,
			forced: 0.9,
			prompts: {},
		});
		expect(resolveSelfCompactionSettings({ enabled: false }).enabled).toBe(false);
	});

	it("rejects malformed settings with a reason and leaves self-compaction inert", () => {
		for (const raw of [
			{ notice: 0.9, warning: 0.5 },
			{ forced: 1.5 },
			{ warning: 0 },
			{ notice: "0.5" },
			{ enabled: "yes" },
			{ enabled: 1 },
		]) {
			const settings = resolveSelfCompactionSettings(raw);
			expect(settings.error, JSON.stringify(raw)).toBeDefined();
			expect(settings.enabled, JSON.stringify(raw)).toBe(false);
			expect(resolveSelfCompactionThresholds(200_000, 180_000, 120_000, settings)).toBeUndefined();
		}
	});

	it("activates valid settings without an error (control)", () => {
		const settings = resolveSelfCompactionSettings({ enabled: true, notice: 0.6, warning: 0.8, forced: 0.9 });
		expect(settings.error).toBeUndefined();
		expect(resolveSelfCompactionThresholds(200_000, 180_000, 120_000, settings)).toBeDefined();
	});
});

describe("self-compaction prompts", () => {
	it("accepts notice, warning and summary prompts that use known placeholders", () => {
		const prompts = {
			notice: "At {{used_tokens}} ({{used_percent}}); forced at {{forced_tokens}}; cycle {{cycle}}.",
			warning: "Warning line {{warning_tokens}} of {{context_window}}; {{tokens_until_forced}} left.",
			summary: "Keep pending work pending. Note limit {{note_max_chars}}.",
		};
		const settings = resolveSelfCompactionSettings({ prompts });
		expect(settings.error).toBeUndefined();
		expect(settings.enabled).toBe(true);
		expect(settings.prompts).toEqual(prompts);
	});

	it("rejects malformed prompts with a reason and leaves self-compaction inert", () => {
		for (const prompts of [
			"notice text",
			[],
			{ forced: "all tools" },
			{ notice: "   " },
			{ warning: 7 },
			{ notice: "at {{used_tokens}} and {{mystery}}" },
			{ summary: "x".repeat(SELF_COMPACTION_PROMPT_MAX_CHARS + 1) },
		]) {
			const settings = resolveSelfCompactionSettings({ prompts });
			expect(settings.error, JSON.stringify(prompts)).toBeDefined();
			expect(settings.enabled, JSON.stringify(prompts)).toBe(false);
		}
		expect(resolveSelfCompactionSettings({ prompts: { notice: "{{mystery}}" } }).error).toContain("{{mystery}}");
	});

	it("renders placeholders from the live thresholds, usage and cycle count", () => {
		const t = thresholdsFor(200_000);
		const values = selfCompactionTemplateValues(t, 100_000, 2);
		expect(
			renderSelfCompactionTemplate("{{used_tokens}} {{used_percent}} {{ cycle }} {{forced_tokens}}", values),
		).toBe(`100,000 50.0% 2 ${t.forcedTokens.toLocaleString("en-US")}`);
		expect(selfCompactionGuidance("notice", t, { notice: "custom {{cycle}}" }, values)).toBe("custom 2");
		expect(selfCompactionGuidance("forced", t, { notice: "custom" }, values)).toContain("self_compact");
	});
});

describe("self-compaction thresholds", () => {
	it("puts notice and warning before the host's early cost trigger and forced before the hard trigger on common windows", () => {
		for (const window of [128_000, 200_000, 1_000_000]) {
			const t = thresholdsFor(window);
			expect(t.earlyTokens).not.toBeNull();
			expect(t.noticeTokens).toBeLessThan(t.warningTokens);
			expect(t.warningTokens).toBeLessThan(t.earlyTokens!);
			expect(t.earlyTokens!).toBeLessThan(t.forcedTokens);
			expect(t.forcedTokens).toBeLessThan(t.hardTokens);
		}
	});

	it("would miss the early trigger if the lines were anchored to the hard trigger alone (control)", () => {
		for (const window of [128_000, 200_000, 1_000_000]) {
			const hard = hardCompactionTriggerTokens(window, DEFAULT_COMPACTION_SETTINGS);
			const early = Math.floor(window * (DEFAULT_COMPACTION_SETTINGS.triggerPercent ?? 0));
			expect(Math.floor(hard * DEFAULT_SELF_COMPACTION_SETTINGS.notice)).toBeGreaterThan(early);
		}
	});

	it("anchors to the hard trigger when no early trigger is configured, and is off without a trigger", () => {
		const t = resolveSelfCompactionThresholds(100_000, 90_000, undefined, DEFAULT_SELF_COMPACTION_SETTINGS)!;
		expect(t.earlyTokens).toBeNull();
		expect(t.noticeTokens).toBe(Math.floor(90_000 * DEFAULT_SELF_COMPACTION_SETTINGS.notice));
		expect(t.forcedTokens).toBe(Math.floor(90_000 * DEFAULT_SELF_COMPACTION_SETTINGS.forced));
		expect(
			resolveSelfCompactionThresholds(100_000, undefined, 60_000, DEFAULT_SELF_COMPACTION_SETTINGS),
		).toBeUndefined();
		expect(
			resolveSelfCompactionThresholds(100_000, 90_000, 60_000, {
				...DEFAULT_SELF_COMPACTION_SETTINGS,
				enabled: false,
			}),
		).toBeUndefined();
	});

	it("maps usage to levels and treats unknown usage as unknown", () => {
		const t = thresholdsFor(200_000);
		expect(selfCompactionLevel(null, t)).toBe("unknown");
		expect(selfCompactionLevel(t.noticeTokens - 1, t)).toBe("idle");
		expect(selfCompactionLevel(t.noticeTokens, t)).toBe("notice");
		expect(selfCompactionLevel(t.warningTokens, t)).toBe("warning");
		expect(selfCompactionLevel(t.forcedTokens, t)).toBe("forced");
	});

	it("keeps guidance text stable within a level so the transient is appended once per level", () => {
		const t = thresholdsFor(200_000);
		const notice = selfCompactionGuidance("notice", t);
		expect(notice).toBe(selfCompactionGuidance("notice", t));
		expect(notice).not.toBe(selfCompactionGuidance("warning", t));
		expect(selfCompactionGuidance("idle", t)).toBeUndefined();
		expect(selfCompactionGuidance("forced", t)).toContain("self_compact");
	});
});

describe("self-compaction note", () => {
	it("keeps the note byte for byte and rejects blank or oversized notes", () => {
		const note = "  goal\n\tNEXT ACTION: run tests  ";
		expect(validateSelfCompactionNote(note)).toEqual({ ok: true, note });
		expect(validateSelfCompactionNote("   ").ok).toBe(false);
		expect(validateSelfCompactionNote(42).ok).toBe(false);
		expect(validateSelfCompactionNote("x".repeat(SELF_COMPACTION_NOTE_MAX_CHARS + 1)).ok).toBe(false);
		expect(validateSelfCompactionNote("x".repeat(SELF_COMPACTION_NOTE_MAX_CHARS)).ok).toBe(true);
	});
});

describe("self-compaction handoff state", () => {
	it("walks pending, compacted, delivered and answered from branch entries only", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "start", timestamp: 1 });
		request(manager, "h1");
		expect(deriveSelfCompactionState(manager.getBranch()).status).toBe("pending");
		manager.appendCompactionStart("c0", manager.getBranch()[0]!.id, 10);
		manager.appendCompactionEnd("c0", "failure", { error: "boom" });
		expect(deriveSelfCompactionState(manager.getBranch())).toMatchObject({ status: "pending", attempts: 1 });
		manager.appendCompaction("summary", manager.getBranch()[0]!.id, 10, { selfCompaction: { handoffId: "other" } });
		expect(deriveSelfCompactionState(manager.getBranch()).status).toBe("pending");
		manager.appendCompaction("summary", manager.getBranch()[0]!.id, 10, { selfCompaction: { handoffId: "h1" } });
		expect(deriveSelfCompactionState(manager.getBranch()).status).toBe("compacted");
		manager.appendCustomMessageEntry(SELF_COMPACTION_HANDOFF_CUSTOM_TYPE, "note h1", true, { handoffId: "h1" });
		expect(deriveSelfCompactionState(manager.getBranch()).status).toBe("delivered");
		manager.appendMessage(assistant("error"));
		expect(deriveSelfCompactionState(manager.getBranch()).status).toBe("delivered");
		manager.appendMessage(assistant());
		expect(deriveSelfCompactionState(manager.getBranch()).status).toBe("answered");
	});

	it("settles a delivered note when the owner aborts the continuation, so a restart does not override the cancel", () => {
		const manager = SessionManager.inMemory();
		request(manager, "h1");
		manager.appendCompaction("summary", manager.getBranch()[0]!.id, 10, { selfCompaction: { handoffId: "h1" } });
		manager.appendCustomMessageEntry(SELF_COMPACTION_HANDOFF_CUSTOM_TYPE, "note h1", true, { handoffId: "h1" });
		manager.appendMessage(assistant("aborted"));
		expect(deriveSelfCompactionState(manager.getBranch()).status).toBe("answered");
	});

	it("counts completed cycles across requests and remembers an owner request until the next note or compaction", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "start", timestamp: 1 });
		for (const id of ["h1", "h2"]) {
			request(manager, id);
			manager.appendCompaction("summary", manager.getBranch()[0]!.id, 10, { selfCompaction: { handoffId: id } });
			manager.appendCustomMessageEntry(SELF_COMPACTION_HANDOFF_CUSTOM_TYPE, `note ${id}`, true, { handoffId: id });
			manager.appendMessage(assistant());
		}
		expect(deriveSelfCompactionState(manager.getBranch())).toMatchObject({ status: "answered", cycles: 2 });
		manager.appendCustomMessageEntry(SELF_COMPACTION_OWNER_REQUEST_CUSTOM_TYPE, "compact now", true);
		expect(deriveSelfCompactionState(manager.getBranch())).toMatchObject({ ownerRequested: true, cycles: 2 });
		request(manager, "h3");
		expect(deriveSelfCompactionState(manager.getBranch())).toMatchObject({
			status: "pending",
			ownerRequested: false,
		});
		manager.appendCustomMessageEntry(SELF_COMPACTION_OWNER_REQUEST_CUSTOM_TYPE, "compact now", true);
		expect(deriveSelfCompactionState(manager.getBranch()).ownerRequested).toBe(false);
		manager.appendCustomEntry(SELF_COMPACTION_ABANDONED_CUSTOM_TYPE, { handoffId: "h3" });
		manager.appendCustomMessageEntry(SELF_COMPACTION_OWNER_REQUEST_CUSTOM_TYPE, "compact now", true);
		expect(deriveSelfCompactionState(manager.getBranch()).ownerRequested).toBe(true);
		manager.appendCompaction("host summary", manager.getBranch()[0]!.id, 10);
		expect(deriveSelfCompactionState(manager.getBranch())).toMatchObject({ ownerRequested: false, cycles: 2 });
	});

	it("expires an owner request when the agent finishes its next reply without saving a note", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "start", timestamp: 1 });
		manager.appendCustomMessageEntry(SELF_COMPACTION_OWNER_REQUEST_CUSTOM_TYPE, "compact now", true);
		manager.appendMessage({ ...assistant(), stopReason: "toolUse" as const });
		expect(deriveSelfCompactionState(manager.getBranch()).ownerRequested).toBe(true);
		manager.appendMessage(assistant("error"));
		expect(deriveSelfCompactionState(manager.getBranch()).ownerRequested).toBe(true);
		manager.appendMessage(assistant());
		expect(deriveSelfCompactionState(manager.getBranch()).ownerRequested).toBe(false);
		manager.appendCustomMessageEntry(SELF_COMPACTION_OWNER_REQUEST_CUSTOM_TYPE, "compact now", true);
		manager.appendMessage(assistant("aborted"));
		expect(deriveSelfCompactionState(manager.getBranch()).ownerRequested).toBe(false);
	});

	it("starts over on a new request and honours an abandonment for the current one only", () => {
		const manager = SessionManager.inMemory();
		request(manager, "h1");
		manager.appendCustomEntry(SELF_COMPACTION_ABANDONED_CUSTOM_TYPE, { handoffId: "old" });
		expect(deriveSelfCompactionState(manager.getBranch()).status).toBe("pending");
		manager.appendCustomEntry(SELF_COMPACTION_ABANDONED_CUSTOM_TYPE, { handoffId: "h1" });
		expect(deriveSelfCompactionState(manager.getBranch()).status).toBe("abandoned");
		request(manager, "h2");
		expect(deriveSelfCompactionState(manager.getBranch())).toMatchObject({
			status: "pending",
			attempts: 0,
			request: { id: "h2" },
		});
	});

	it("ignores malformed or oversized request records on replay, and accepts a well-formed one (control)", () => {
		const valid = {
			id: "h1",
			note: "NEXT ACTION: go",
			requestedAt: new Date().toISOString(),
			level: "warning",
			tokens: 10,
		};
		const entry = (data: unknown) =>
			({
				type: "custom",
				customType: SELF_COMPACTION_REQUEST_CUSTOM_TYPE,
				data,
				id: "e1",
				parentId: null,
				timestamp: new Date().toISOString(),
			}) as SessionEntry;
		for (const data of [
			{ note: "no id" },
			{ ...valid, note: "   " },
			{ ...valid, note: "x".repeat(SELF_COMPACTION_NOTE_MAX_CHARS + 1) },
			{ ...valid, id: "x".repeat(200) },
			{ ...valid, requestedAt: "not a date" },
			{ ...valid, level: "panic" },
			{ ...valid, tokens: "10" },
			[valid],
		]) {
			expect(
				applySelfCompactionEntry({ status: "none", attempts: 0, cycles: 0, ownerRequested: false }, entry(data))
					.status,
				JSON.stringify(data),
			).toBe("none");
		}
		expect(
			applySelfCompactionEntry({ status: "none", attempts: 0, cycles: 0, ownerRequested: false }, entry(valid))
				.status,
		).toBe("pending");
	});

	it("derives the same state incrementally as from the whole branch, across appends and a branch switch", () => {
		const manager = SessionManager.inMemory();
		const scan = new SelfCompactionStateScan();
		const incremental = () => scan.find(resolveSessionEntryIndex(manager)!);
		manager.appendMessage({ role: "user", content: "start", timestamp: 1 });
		const fork = manager.getLeafId()!;
		expect(incremental().status).toBe("none");
		request(manager, "h1");
		expect(incremental()).toEqual(deriveSelfCompactionState(manager.getBranch()));
		manager.appendCompaction("summary", manager.getBranch()[0]!.id, 10, { selfCompaction: { handoffId: "h1" } });
		manager.appendCustomMessageEntry(SELF_COMPACTION_HANDOFF_CUSTOM_TYPE, "note h1", true, { handoffId: "h1" });
		expect(incremental().status).toBe("delivered");
		manager.branch(fork);
		expect(incremental().status).toBe("none");
		expect(incremental()).toEqual(deriveSelfCompactionState(manager.getBranch()));
	});
});

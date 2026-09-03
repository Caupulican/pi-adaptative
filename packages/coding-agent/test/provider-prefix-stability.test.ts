/**
 * PREFIX-STABILITY regression guard.
 *
 * Every provider request re-sends the whole conversation, and the provider prefills it against the
 * longest byte-identical prefix it has already seen. Any send-time pass that rewrites a message in
 * place, or that changes the system prompt, moves bytes inside that prefix and forces a re-prefill
 * of everything from there on. Left unguarded this is invisible: the agent still works, it is just
 * slow and expensive in proportion to context size, on every single request.
 *
 * These tests pin the three passes that used to break it: the path-alias legend (was rendered into
 * the system prompt, scoped to the visible window, so it flapped at byte zero), path-alias
 * rewriting (retro-rewrote already-sent history whenever a later turn minted an alias), and the
 * context-GC packing boundary (advanced one position per appended message, rewriting the tail every
 * turn).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathAliasRuntime } from "../src/core/context/path-alias-session.ts";
import { quantizeRecentBoundary, resolveRecentBoundaryStride } from "../src/core/context/prefix-stability.ts";
import { applyContextGc, getContextGcSettings } from "../src/core/context-gc.ts";
import {
	PATH_ALIAS_LEGEND_CUSTOM_TYPE,
	ProviderRequestContextController,
} from "../src/core/provider-request-context-controller.ts";
import type { SkillVaultController } from "../src/core/skill-vault.ts";

const CWD = "/repo";

function user(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function textsOf(messages: readonly AgentMessage[]): string[] {
	return messages.map((message) => JSON.stringify(message));
}

describe("path alias projection is append-only across requests", () => {
	let dir: string;
	let runtime: PathAliasRuntime;
	let turn = 0;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-prefix-stability-"));
		turn = 0;
		runtime = new PathAliasRuntime(
			() => CWD,
			() => join(dir, "aliases.sqlite"),
			() => turn++,
			{ requireExistingTargets: false },
		);
	});

	afterEach(() => {
		runtime.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("keeps already-sent history byte-identical when a later turn mints an alias matching it", () => {
		// `srcdirectory/a.ts` carries one separator and too few characters to mint an alias on turn 1, so turn 1
		// goes to the provider spelled literally. Turn 2 names the same file as `./srcdirectory/a.ts`, which does
		// clear the bar and mints `p/a.ts` — whose rewrite forms include the bare `srcdirectory/a.ts` that turn 1
		// already sent. Both spellings are relative with forward slashes, so the trigger does not depend
		// on how the host resolves an absolute path (an absolute spelling here passed on Linux and
		// minted nothing on Windows).
		const first: AgentMessage[] = [user("open srcdirectory/a.ts", 1)];
		const firstRender = runtime.sync(first);
		expect(JSON.stringify(firstRender.messages[0])).toContain("srcdirectory/a.ts");

		const second: AgentMessage[] = [...first, user("now compare with ./srcdirectory/a.ts", 2)];
		const secondRender = runtime.sync(second);

		expect(secondRender.legend).toContain("=srcdirectory/a.ts");
		expect(textsOf(secondRender.messages.slice(0, first.length))).toEqual(textsOf(firstRender.messages));
	});

	it("never retracts a legend line once an alias scrolls out of the visible window", () => {
		const first: AgentMessage[] = [user("read packages/coding-agent/src/core/alpha.ts", 1)];
		const firstLegend = runtime.sync(first).legend;
		expect(firstLegend).toContain("=packages/coding-agent/src/core/alpha.ts");

		// alpha.ts is gone from the window entirely (compaction, GC packing, a rolling window): the
		// legend must still grow by appended lines, never shrink.
		const second: AgentMessage[] = [user("now read packages/coding-agent/src/core/beta.ts", 2)];
		const secondLegend = runtime.sync(second).legend;

		expect(secondLegend?.startsWith(firstLegend ?? "")).toBe(true);
		expect(secondLegend).toContain("=packages/coding-agent/src/core/beta.ts");
	});

	it("returns the same bytes for the repeated syncs one request performs", () => {
		const messages: AgentMessage[] = [user("open packages/coding-agent/src/core/alpha.ts", 1)];
		// plan() previews, projects for prepareCommit, then projects again for commit.
		const preview = runtime.sync(messages);
		const projected = runtime.sync(messages);
		const committed = runtime.sync(messages);

		expect(textsOf(projected.messages)).toEqual(textsOf(preview.messages));
		expect(textsOf(committed.messages)).toEqual(textsOf(preview.messages));
		expect(projected.legend).toBe(preview.legend);
		expect(committed.legend).toBe(preview.legend);
	});
});

describe("context GC packing boundary", () => {
	function bulkyRead(id: string, index: number): AgentMessage[] {
		return [
			{
				role: "assistant",
				content: [{ type: "toolCall", id, name: "bash", arguments: { command: `echo ${index}` } }],
				timestamp: index,
			} as unknown as AgentMessage,
			{
				role: "toolResult",
				toolCallId: id,
				toolName: "bash",
				content: [{ type: "text", text: `OUTPUT ${index} ${"payload ".repeat(400)}` }],
				isError: false,
				timestamp: index,
			} as unknown as AgentMessage,
		];
	}

	function packedAt(messageCount: number): string[] {
		const messages: AgentMessage[] = [];
		for (let index = 0; messages.length < messageCount; index++) messages.push(...bulkyRead(`call-${index}`, index));
		const result = applyContextGc(messages.slice(0, messageCount), {
			...getContextGcSettings(),
			cwd: CWD,
			writePayloads: false,
		});
		return result.report.records.map((record) => record.toolCallId);
	}

	it("does not change which messages are packed while the boundary sits between grid points", () => {
		// Default window 24, grid 12: the boundary sits at 36 for every length in [36, 47], so no
		// message changes spelling anywhere in that range and the provider prefix stays valid.
		const atGridPoint = packedAt(36);
		expect(atGridPoint.length).toBeGreaterThan(0);
		for (const length of [38, 40, 44, 46]) {
			expect(packedAt(length)).toEqual(atGridPoint);
		}
	});

	it("advances at the next grid point, packing a batch instead of one message per turn", () => {
		expect(packedAt(48).length).toBeGreaterThan(packedAt(46).length);
	});

	it("keeps the boundary monotone so a packed message never un-packs as history grows", () => {
		let previous = 0;
		for (let length = 0; length <= 96; length++) {
			const boundary = quantizeRecentBoundary(Math.max(0, length - 24), 12);
			expect(boundary).toBeGreaterThanOrEqual(previous);
			expect(boundary).toBeLessThanOrEqual(Math.max(0, length - 24));
			previous = boundary;
		}
	});

	it("clamps a stride carried over from a spread settings object to the window it quantizes", () => {
		// `{...getContextGcSettings(), preserveRecentMessages: 1}` is a common shape: the default
		// stride must not survive onto a window it would more than double.
		expect(resolveRecentBoundaryStride(1, 12)).toBe(1);
		expect(resolveRecentBoundaryStride(24, undefined)).toBe(12);
		expect(resolveRecentBoundaryStride(24, 1)).toBe(1);
	});
});

describe("path alias legend placement", () => {
	it("rides at the tail of the request and never in the system prompt", async () => {
		const controller = new ProviderRequestContextController({
			transformBase: async (messages) => messages,
			transformExtensions: async (messages) => ({ messages, transientMessages: [] }),
			runContextAudit: () => ({}) as never,
			runPromptPolicyPlanning: () => ({}) as never,
			runMemoryRetrieval: async () => ({}) as never,
			applyContextGc: (messages) => ({ messages, report: {} as never, isCurrent: () => true, commit: () => {} }),
			correlatePromptPolicyWithContextGc: () => {},
			runPromptEnforcement: (messages) => ({ messages, report: {} as never }),
			enqueueRelevanceCuration: () => {},
			maybeDrainBrainCuration: () => {},
			appendMemoryEvidence: (messages) => messages,
			previewReflectionCue: () => undefined,
			getGoalState: () => undefined,
			skillVault: {
				previewSystemPromptSection: () => undefined,
				commitSystemPromptSection: () => undefined,
				getContextRevision: () => 1,
			} as unknown as SkillVaultController,
			applyPathAliases: (messages) => ({ messages, legend: "PATH ALIASES\np/alpha.ts=src/core/alpha.ts" }),
		});

		const plan = await controller.plan([user("hi", 1)], 0);

		expect(plan.transientSystemPrompt).toBeUndefined();
		expect(plan.transientMessages?.at(-1)).toMatchObject({
			role: "custom",
			customType: PATH_ALIAS_LEGEND_CUSTOM_TYPE,
			content: "PATH ALIASES\np/alpha.ts=src/core/alpha.ts",
		});
	});
});

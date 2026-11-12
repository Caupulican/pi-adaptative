/** Normal reopen/import of the old mixed parent-input receipt, copied from a real composed run. */
import { basename, join } from "node:path";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import {
	type ParentInputConsumption,
	parentInputRequestBindingOf,
} from "../../../../src/kernel/session/parent-input-ledger.ts";
import type { SessionEntry } from "../../../../src/kernel/session/session-entries.ts";
import type { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import type { HarnessWorld } from "../session-fixture.ts";
import {
	icmContinuousSettings,
	icmContinuousStore,
	icmReadContinuousRecords,
	icmWaitForChatIdle,
	utf8Text,
} from "./shared.ts";

type Receipt = { entry: SessionEntry; value: ParentInputConsumption };

export async function verifyParentInputLegacyOverlap(
	world: HarnessWorld,
	manager: SessionManager,
	owner: Receipt,
	wake: Receipt,
	settlement: SessionEntry,
	keys: readonly string[],
): Promise<void> {
	const source = manager.getSessionFile();
	if (!source) throw new Error("H25 legacy import needs the real persisted source.");
	const header = utf8Text(world.io.readFileSync(source, "utf8")).split("\n")[0];
	if (!header) throw new Error("H25 legacy import needs the original session header.");
	const end = manager.getEntries().findIndex((entry) => entry.id === wake.entry.id);
	if (end < 0) throw new Error("H25 wake receipt was not captured.");
	const legacy = structuredClone(manager.getEntries().slice(0, end + 1)).filter(
		(entry) => entry.id !== owner.entry.id,
	);
	const oldSettlement = legacy.find((entry) => entry.id === settlement.id);
	const oldReceipt = legacy.find((entry) => entry.id === wake.entry.id);
	if (oldSettlement?.type !== "custom" || oldReceipt?.type !== "custom")
		throw new Error("H25 captured receipts changed shape.");
	oldSettlement.parentId = owner.value.terminalEntryId;
	oldReceipt.data = { ...wake.value, bindingEntryId: owner.value.bindingEntryId, inputs: owner.value.inputs };
	const wakeBinding = legacy.find((entry) => {
		const binding = parentInputRequestBindingOf(entry);
		return binding?.kind === "wake" && binding.requestId === wake.value.requestId;
	});
	if (!wakeBinding) throw new Error("H25 captured wake binding is absent.");
	const negative = (
		kind: "missing" | "wrong" | "foreign" | "duplicate" | "altered" | "failed" | "aborted" | "nonfinal",
	): SessionEntry[] => {
		const copied = structuredClone(legacy);
		const hybrid = copied.find((entry) => entry.id === oldReceipt.id);
		if (hybrid?.type !== "custom") throw new Error("H25 copied hybrid is absent.");
		if (kind === "wrong")
			hybrid.data = {
				...wake.value,
				bindingEntryId: owner.value.bindingEntryId,
				inputs: owner.value.inputs.map((input) => ({ ...input, payloadDigest: "0".repeat(64) })),
			};
		if (kind === "foreign")
			hybrid.data = {
				...wake.value,
				authorizationEntryId: owner.value.authorizationEntryId,
				bindingEntryId: owner.value.bindingEntryId,
				inputs: owner.value.inputs,
			};
		if (kind === "altered") {
			const original = copied.find((entry) => entry.id === owner.value.inputs[0]?.entryId);
			if (original?.type !== "custom_message" || typeof original.content !== "string")
				throw new Error("H25 copied notice is absent.");
			original.content += " altered";
		}
		if (kind === "failed" || kind === "aborted") {
			const terminal = copied.find((entry) => entry.id === wake.value.terminalEntryId);
			if (terminal?.type !== "provider_request_terminal") throw new Error("H25 copied terminal is absent.");
			terminal.outcome = kind === "failed" ? "error" : "aborted";
		}
		if (kind === "nonfinal") {
			const answer = copied.find((entry) => entry.id === wake.value.assistantMessageEntryId);
			if (answer?.type !== "message" || answer.message.role !== "assistant")
				throw new Error("H25 copied answer is absent.");
			answer.message.stopReason = "toolUse";
		}
		if (kind === "missing") {
			const removed = copied.find((entry) => entry.id === wakeBinding.id)!;
			for (const entry of copied) if (entry.parentId === removed.id) entry.parentId = removed.parentId;
			return copied.filter((entry) => entry.id !== removed.id);
		}
		if (kind === "duplicate") {
			const at = copied.findIndex((entry) => entry.id === wakeBinding.id);
			const first = copied[at]!;
			let duplicateId = "f25c0ffe";
			while (copied.some((entry) => entry.id === duplicateId))
				duplicateId = (Number.parseInt(duplicateId, 16) - 1).toString(16).padStart(8, "0");
			const second = { ...structuredClone(first), id: duplicateId, parentId: first.id };
			for (const entry of copied) if (entry.parentId === first.id) entry.parentId = second.id;
			copied.splice(at + 1, 0, second);
		}
		return copied;
	};
	for (const kind of [
		"missing",
		"wrong",
		"foreign",
		"duplicate",
		"altered",
		"failed",
		"aborted",
		"nonfinal",
	] as const) {
		const agentDir = `${world.agentDir}-h25-invalid-${kind}`;
		const target = world.createSessionManager(agentDir);
		world.io.mkdirSync(target.getSessionDir(), { recursive: true });
		const path = join(target.getSessionDir(), basename(source));
		world.io.writeFileSync(
			path,
			`${header}\n${negative(kind)
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const expected =
			kind === "missing"
				? /Parent wake settlement lacks matching provider evidence/
				: kind === "duplicate"
					? /Parent wake request binding requires inspection/
					: kind === "altered"
						? /Parent input payload does not match its saved digest/
						: kind === "wrong" || kind === "foreign"
							? /Consumed parent note projection has no exact terminal proof/
							: /Parent wake settlement lacks matching provider evidence|terminal/i;
		expect(
			() => world.openSessionManager(path, agentDir).getPendingParentInputs(),
			`H25 ${kind} legacy proof fails closed on normal reopen`,
		).toThrow(expected);
	}
	const agentDir = `${world.agentDir}-h25-legacy`;
	const target = world.createSessionManager(agentDir);
	world.io.mkdirSync(target.getSessionDir(), { recursive: true });
	const path = join(target.getSessionDir(), basename(source));
	const bytes = `${header}\n${legacy.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	world.io.writeFileSync(path, bytes);
	const settings = icmContinuousSettings("worker-b", {
		autoLearn: { enabled: false },
		proactivity: { enabled: false },
	});
	const priorModel = world.provider.model("worker-b");
	const beforeRequests = world.provider.requests.filter((request) => request.model.id === "worker-b").length;
	const tracks: string[] = [];
	const failures: unknown[] = [];
	let active: AgentSession | undefined;
	try {
		// This new store can summarize the same dyadic ranges as the still-live original store.
		// Its own model and bounded scripts keep those two real actors from consuming each other's replies.
		world.setModelReasoning("worker-b", true, { xhigh: "xhigh" });
		for (let size = 1; size <= 256; size *= 2)
			for (let first = 0; first + size <= 256; first += size) {
				const task =
					size === 1
						? `Compaction: compress message ${first} into`
						: `Compaction: merge lines ${first}+${size / 2} and ${first + size / 2}+${size / 2},`;
				const name = `h25-legacy-compaction-${first}+${size}`;
				tracks.push(name);
				world.provider.enqueueTrack(
					name,
					"worker-b",
					(request) => JSON.stringify(request.context.messages.at(-1)).includes(task),
					{
						name,
						optional: true,
						reply: { content: [{ type: "text", text: "Verified background deliveries and earlier history." }] },
					},
				);
			}
		let firstRequests: number | undefined;
		for (let pass = 0; pass < 2; pass++) {
			const opened = await world.createRootSession("root", {
				agentDir,
				sessionManager: world.createSessionManager(agentDir),
				settings,
			});
			active = opened.session;
			const store = icmContinuousStore(agentDir);
			await icmWaitForChatIdle(world, agentDir, 1, () => world.io.existsSync(store.migrationFile));
			const records = icmReadContinuousRecords(world, store);
			for (const key of keys) expect(records.filter((record) => record.sourceKey === key)).toHaveLength(1);
			expect(utf8Text(world.io.readFileSync(path, "utf8"))).toBe(bytes);
			expect(await world.disposeSessionInBody(active)).toBeUndefined();
			active = undefined;
			await world.provider.waitForProducers();
			const requests = world.provider.requests.filter((request) => request.model.id === "worker-b").length;
			if (pass === 0) {
				expect(requests, "the imported store dispatches real summaries").toBeGreaterThan(beforeRequests);
				firstRequests = requests;
			} else expect(requests, "reopening the imported store starts no duplicate summaries").toBe(firstRequests);
		}
	} catch (error) {
		failures.push(error);
	} finally {
		try {
			if (active) expect(await world.disposeSessionInBody(active)).toBeUndefined();
		} catch (error) {
			failures.push(error);
		}
		let joined = false;
		try {
			await world.provider.waitForProducers();
			joined = true;
		} catch (error) {
			failures.push(error);
		}
		if (joined) {
			for (const track of tracks) {
				try {
					world.provider.retireOptional(track);
				} catch (error) {
					failures.push(error);
				}
			}
		}
		try {
			world.setModelReasoning("worker-b", priorModel.reasoning, priorModel.thinkingLevelMap);
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, "H25 legacy import and cleanup failures");
}

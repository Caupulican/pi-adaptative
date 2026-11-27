import { expect, it } from "vitest";
import {
	keepOutwardDraft,
	OUTWARD_DRAFT_STATE_CUSTOM_TYPE,
	outwardDraftStates,
} from "../src/core/agent-session-edge.ts";
import { registerOutwardDraftRelease } from "../src/core/autonomy/owner-draft-decisions.ts";
import { ownerSessionStorageRoots } from "../src/kernel/session/session-bundle-paths.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";

it("keeps a watch draft pending until its exact terminal call starts", () => {
	const manager = SessionManager.inMemory(ownerSessionStorageRoots(process.cwd()), process.cwd());
	const operations = [
		{ class: "operation.irreversible" as const, operation: "apply update", reason: "changes live state" },
	];
	const origin = { v: 1 as const, k: "inbound-channel" as const, thirdParty: true as const };
	const call = { toolName: "update", args: { target: "alpha" } };
	const other = { ...call, args: { target: "beta" } };
	const hold = (item: typeof call) =>
		keepOutwardDraft(manager, { origin, toolName: item.toolName, operations, call: item });
	const held = hold(call),
		distinct = hold(other);
	expect(held.id).not.toBe(distinct.id);
	expect(held.added?.rendering).toBeUndefined();
	const legacy = keepOutwardDraft(manager, { origin, toolName: call.toolName, operations });
	expect(legacy.added?.callDigest).toBeUndefined();
	const starts: (() => void)[] = [];
	registerOutwardDraftRelease(
		manager,
		call,
		() => operations,
		(start) => starts.push(start),
	);
	expect(starts).toHaveLength(1);
	expect(outwardDraftStates(manager.getBranch(), true).map((row) => row.state)).toEqual([
		"pending",
		"pending",
		"pending",
	]);
	starts[0]!();
	starts[0]!();
	expect(outwardDraftStates(manager.getBranch(), true).map((row) => row.state)).toEqual([
		"released",
		"pending",
		"released",
	]);
	expect(manager.getCustomEntriesOnBranch([OUTWARD_DRAFT_STATE_CUSTOM_TYPE])).toHaveLength(1);
});

it("keeps a legacy operations-only draft held when a later gate refuses the call or the owner switches branches", () => {
	const manager = SessionManager.inMemory(ownerSessionStorageRoots(process.cwd()), process.cwd());
	const root = manager.appendCustomEntry("root", {});
	const operations = [
		{ class: "operation.irreversible" as const, operation: "apply update", reason: "changes live state" },
	];
	keepOutwardDraft(manager, {
		toolName: "update",
		origin: { v: 1, k: "inbound-channel", thirdParty: true },
		operations,
	});
	const leaf = manager.getLeafId()!;
	const callbacks: (() => void)[] = [];
	registerOutwardDraftRelease(
		manager,
		{ toolName: "update", args: {} },
		() => operations,
		(start) => callbacks.push(start),
	);
	expect(callbacks).toHaveLength(1);
	expect(outwardDraftStates(manager.getBranch(), true)[0]?.state).toBe("pending");
	manager.branch(root);
	expect(() => callbacks[0]!()).toThrow(/branch changed/);
	manager.branch(leaf);
	expect(outwardDraftStates(manager.getBranch(), true)[0]?.state).toBe("pending");
});

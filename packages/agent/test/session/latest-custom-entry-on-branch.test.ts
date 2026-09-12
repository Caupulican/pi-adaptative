import { describe, expect, it } from "vitest";
import { type CustomEntry, SessionManager } from "../../src/session/session-manager.ts";

function userMsg(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

describe("SessionManager.getLatestCustomEntryOnBranch", () => {
	it("returns undefined when no entry of that customType exists", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("hello"));

		expect(session.getLatestCustomEntryOnBranch("goal_state")).toBeUndefined();
	});

	it("returns the single matching entry when there is exactly one", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("hello"));
		const id = session.appendCustomEntry("goal_state", { v: 1 });

		const found = session.getLatestCustomEntryOnBranch("goal_state");
		expect(found?.id).toBe(id);
		expect(found?.customType).toBe("goal_state");
	});

	it("returns the MOST RECENT of several matching entries on a linear branch", () => {
		const session = SessionManager.inMemory();
		session.appendCustomEntry("goal_state", { v: 1 });
		session.appendCustomEntry("goal_state", { v: 2 });
		const third = session.appendCustomEntry("goal_state", { v: 3 });

		const found = session.getLatestCustomEntryOnBranch("goal_state");
		expect(found?.id).toBe(third);
		expect(found?.data).toEqual({ v: 3 });
	});

	it("ignores entries of a different customType", () => {
		const session = SessionManager.inMemory();
		session.appendCustomEntry("goal_state", { v: 1 });
		const taskEntry = session.appendCustomEntry("task_steps_state", { v: 1 });

		const found = session.getLatestCustomEntryOnBranch("task_steps_state");
		expect(found?.id).toBe(taskEntry);
	});

	it("scopes to the active branch: a sibling branch's custom entry is invisible from the other branch", () => {
		const session = SessionManager.inMemory();
		const root = session.appendMessage(userMsg("root"));
		const branchAEntry = session.appendCustomEntry("goal_state", { branch: "A" });

		// Fork from root onto a second branch and record different state there.
		session.branch(root);
		const branchBEntry = session.appendCustomEntry("goal_state", { branch: "B" });

		// The leaf is now on branch B: only branch B's entry is visible.
		const foundOnB = session.getLatestCustomEntryOnBranch("goal_state");
		expect(foundOnB?.id).toBe(branchBEntry);
		expect(foundOnB?.data).toEqual({ branch: "B" });

		// Switching the leaf back to branch A's own entry makes branch A's state visible again;
		// branch B's entry (never an ancestor of branch A's leaf) is not seen.
		session.branch(branchAEntry);
		const foundOnA = session.getLatestCustomEntryOnBranch("goal_state");
		expect(foundOnA?.id).toBe(branchAEntry);
		expect(foundOnA?.data).toEqual({ branch: "A" });
	});

	it("fromId resumes the walk from that entry (inclusive), skipping anything after it", () => {
		const session = SessionManager.inMemory();
		const first = session.appendCustomEntry("goal_state", { v: "first" });
		session.appendCustomEntry("goal_state", { v: "second" });

		// Starting the walk explicitly at the first entry's id must not see the later "second" entry.
		const found = session.getLatestCustomEntryOnBranch("goal_state", first);
		expect(found?.id).toBe(first);
		expect(found?.data).toEqual({ v: "first" });
	});

	/** Count ancestry-index reads so the cost claims below are deterministic, not timing-based. */
	function countIndexReads(session: SessionManager, query: () => unknown): number {
		const byId = Reflect.get(session, "byId");
		if (!(byId instanceof Map)) throw new Error("SessionManager ancestry index is not a Map");
		const original = byId.get;
		let reads = 0;
		byId.get = function (key: string) {
			reads++;
			return original.call(this, key);
		};
		try {
			query();
		} finally {
			byId.get = original;
		}
		return reads;
	}

	it("remembers a miss per custom type: same-leaf and one-append queries stop walking the whole branch", () => {
		const session = SessionManager.inMemory();
		for (let index = 0; index < 2_000; index++) session.appendMessage(userMsg(`history ${index}`));

		const cold = countIndexReads(session, () => session.getLatestCustomEntryOnBranch("task_automation_state"));
		expect(cold).toBeGreaterThanOrEqual(2_000);
		expect(session.getLatestCustomEntryOnBranch("task_automation_state")).toBeUndefined();

		// Same leaf: answered from the memo, no ancestry read at all.
		expect(countIndexReads(session, () => session.getLatestCustomEntryOnBranch("task_automation_state"))).toBe(0);

		// One append: only the appended suffix is walked (the new leaf and its parent).
		session.appendMessage(userMsg("one more"));
		expect(
			countIndexReads(session, () => session.getLatestCustomEntryOnBranch("task_automation_state")),
		).toBeLessThanOrEqual(2);
		expect(session.getLatestCustomEntryOnBranch("task_automation_state")).toBeUndefined();

		// A newer matching entry is found in the suffix without re-walking history, and a later
		// query for it stays cheap.
		const id = session.appendCustomEntry("task_automation_state", { v: 1 });
		expect(session.getLatestCustomEntryOnBranch("task_automation_state")?.id).toBe(id);
		session.appendMessage(userMsg("after the record"));
		expect(
			countIndexReads(session, () => session.getLatestCustomEntryOnBranch("task_automation_state")),
		).toBeLessThanOrEqual(2);
		expect(session.getLatestCustomEntryOnBranch("task_automation_state")?.id).toBe(id);

		// Other types keep their own memo; an unrelated type is not answered from this one.
		expect(session.getLatestCustomEntryOnBranch("task_directory_state")).toBeUndefined();
		expect(countIndexReads(session, () => session.getLatestCustomEntryOnBranch("task_directory_state"))).toBe(0);

		// Explicit resume points are never memoized: walking from the record's parent still searches.
		const latest = session.getLatestCustomEntryOnBranch("task_automation_state") as CustomEntry;
		expect(
			session.getLatestCustomEntryOnBranch("task_automation_state", latest.parentId ?? undefined),
		).toBeUndefined();
	});

	it("negative control: a branch switch recomputes against the new ancestry instead of reusing the memo", () => {
		const session = SessionManager.inMemory();
		const root = session.appendMessage(userMsg("root"));
		const branchAEntry = session.appendCustomEntry("goal_state", { branch: "A" });
		let branchALeaf = branchAEntry;
		for (let index = 0; index < 200; index++) branchALeaf = session.appendMessage(userMsg(`A ${index}`));
		expect(session.getLatestCustomEntryOnBranch("goal_state")?.id).toBe(branchAEntry);

		// Switch to a sibling branch: A's leaf is not an ancestor of the root, so the memo (leaf A,
		// hit A) is not reused and A's entry must not surface.
		session.branch(root);
		expect(session.getLatestCustomEntryOnBranch("goal_state")).toBeUndefined();
		const branchBEntry = session.appendCustomEntry("goal_state", { branch: "B" });
		expect(session.getLatestCustomEntryOnBranch("goal_state")?.id).toBe(branchBEntry);

		// Back onto A's deep leaf: the memo names B's leaf, which is not an ancestor, so the walk
		// recomputes down the 200 A messages to A's record instead of stopping after the suffix.
		session.branch(branchALeaf);
		const readsBack = countIndexReads(session, () => session.getLatestCustomEntryOnBranch("goal_state"));
		expect(readsBack).toBeGreaterThanOrEqual(200);
		expect(session.getLatestCustomEntryOnBranch("goal_state")?.id).toBe(branchAEntry);
		// And once recomputed, the same-leaf query is a memo hit again.
		expect(countIndexReads(session, () => session.getLatestCustomEntryOnBranch("goal_state"))).toBe(0);
	});

	it("negative control: index replacement with reused entry ids and a new session drop the memo", () => {
		const session = SessionManager.inMemory();
		const root = session.appendMessage(userMsg("root"));
		const recordId = session.appendCustomEntry("goal_state", { v: "kept" });
		session.appendMessage(userMsg("leaf"));
		expect(session.getLatestCustomEntryOnBranch("goal_state")?.id).toBe(recordId);

		// A branched session rebuilds the index with the same entry ids; the answer must come from
		// the rebuilt index's own objects, not the memoized ones.
		session.createBranchedSession(recordId);
		const rebuilt = session.getLatestCustomEntryOnBranch("goal_state");
		expect(rebuilt?.id).toBe(recordId);
		expect(rebuilt).toBe(session.getEntry(recordId));

		// Branching below the record makes it invisible even though its id was memoized as a hit.
		session.createBranchedSession(root);
		expect(session.getLatestCustomEntryOnBranch("goal_state")).toBeUndefined();

		// A new session clears the index in place (same Map object): the memo must not survive it.
		session.appendCustomEntry("goal_state", { v: "before reset" });
		expect(session.getLatestCustomEntryOnBranch("goal_state")?.data).toEqual({ v: "before reset" });
		session.newSession();
		expect(session.getLatestCustomEntryOnBranch("goal_state")).toBeUndefined();
		const fresh = session.appendCustomEntry("goal_state", { v: "fresh" });
		expect(session.getLatestCustomEntryOnBranch("goal_state")?.id).toBe(fresh);
	});

	it("walking from a matching entry's parentId resumes the search one step further up the ancestry", () => {
		const session = SessionManager.inMemory();
		const older = session.appendCustomEntry("goal_state", { v: "older" });
		const newer = session.appendCustomEntry("goal_state", { v: "newer" });

		const latest = session.getLatestCustomEntryOnBranch("goal_state") as CustomEntry;
		expect(latest.id).toBe(newer);

		// Resuming from the parent of the latest match should surface the older one.
		const resumed = session.getLatestCustomEntryOnBranch("goal_state", latest.parentId ?? undefined);
		expect(resumed?.id).toBe(older);
	});
});

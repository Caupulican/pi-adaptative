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
		expect((found?.data as { v: number }).v).toBe(3);
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
		expect((foundOnB?.data as { branch: string }).branch).toBe("B");

		// Switching the leaf back to branch A's own entry makes branch A's state visible again;
		// branch B's entry (never an ancestor of branch A's leaf) is not seen.
		session.branch(branchAEntry);
		const foundOnA = session.getLatestCustomEntryOnBranch("goal_state");
		expect(foundOnA?.id).toBe(branchAEntry);
		expect((foundOnA?.data as { branch: string }).branch).toBe("A");
	});

	it("fromId resumes the walk from that entry (inclusive), skipping anything after it", () => {
		const session = SessionManager.inMemory();
		const first = session.appendCustomEntry("goal_state", { v: "first" });
		session.appendCustomEntry("goal_state", { v: "second" });

		// Starting the walk explicitly at the first entry's id must not see the later "second" entry.
		const found = session.getLatestCustomEntryOnBranch("goal_state", first);
		expect(found?.id).toBe(first);
		expect((found?.data as { v: string }).v).toBe("first");
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

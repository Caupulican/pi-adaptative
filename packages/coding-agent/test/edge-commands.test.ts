import { describe, expect, it } from "vitest";
import { EDGE_CLASSES, type EdgeClass, type EdgeGrantView } from "../src/core/autonomy/edge-policy.ts";
import { type EdgeHost, handleEdgeCommand, resolveEdgeTargets } from "../src/modes/interactive/edge-commands.ts";

/**
 * The operator's full-grant gesture: one command that grants (or revokes) every edge class for the
 * whole work, recorded per class so a later single revoke narrows it instead of undoing it.
 */
function host(initial: EdgeClass[] = []) {
	const granted = new Set<EdgeClass>(initial);
	const status: string[] = [];
	const errors: string[] = [];
	const notes = new Map<EdgeClass, string | undefined>();
	const edgeHost: EdgeHost = {
		getEdgeGrants: () => [...granted].map((cls): EdgeGrantView => ({ class: cls, source: "operator" })),
		grantEdge: async (cls, note) => {
			granted.add(cls);
			notes.set(cls, note);
		},
		revokeEdge: async (cls) => granted.delete(cls),
		showStatus: (message) => status.push(message),
		showError: (message) => errors.push(message),
		showText: () => {},
	};
	return { edgeHost, granted, status, errors, notes };
}

describe("/edge allow all", () => {
	it("resolves all, explicit lists, and refuses a class typo", () => {
		expect(resolveEdgeTargets(["all"])?.classes).toEqual([...EDGE_CLASSES]);
		expect(resolveEdgeTargets(["git.publish", "package.publish", "for", "the", "release"])).toEqual({
			classes: ["git.publish", "package.publish"],
			note: "for the release",
		});
		expect(resolveEdgeTargets(["git.publsh"])).toBeUndefined();
		expect(resolveEdgeTargets([])).toBeUndefined();
	});

	it("grants every class with one command, each as its own durable grant", async () => {
		const h = host();
		await handleEdgeCommand(h.edgeHost, "/edge allow all full grants until the work is done");
		expect([...h.granted]).toEqual([...EDGE_CLASSES]);
		for (const cls of EDGE_CLASSES) expect(h.notes.get(cls)).toBe("full grants until the work is done");
		expect(h.status.at(-1)).toMatch(/every class granted/);
		expect(h.errors).toEqual([]);
	});

	it("revokes one class out of a full grant without touching the others", async () => {
		const h = host([...EDGE_CLASSES]);
		await handleEdgeCommand(h.edgeHost, "/edge revoke git.publish");
		expect(h.granted.has("git.publish")).toBe(false);
		expect(h.granted.size).toBe(EDGE_CLASSES.length - 1);
		await handleEdgeCommand(h.edgeHost, "/edge revoke all");
		expect(h.granted.size).toBe(0);
		expect(h.status.at(-1)).toMatch(/revoked/);
	});

	it("refuses a misspelled class instead of granting less than asked", async () => {
		const h = host();
		await handleEdgeCommand(h.edgeHost, "/edge allow git.publsh");
		expect(h.granted.size).toBe(0);
		expect(h.errors.at(-1)).toMatch(/or all/);
	});
});

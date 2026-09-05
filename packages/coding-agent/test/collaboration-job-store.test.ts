import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { boundCollaborationEvidence, CollaborationJobStore } from "../src/core/collaboration/job-store.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(allowedTools = ["read", "bash"]) {
	const root = await mkdtemp(join(tmpdir(), "pi-collaboration-store-"));
	roots.push(root);
	const store = new CollaborationJobStore(root, "parent");
	store.create({
		id: "job-one",
		parentSessionId: "parent",
		sessionName: "pi-job-one",
		cwd: root,
		title: "team",
		createdAt: 1,
		deadlineSeconds: 30,
		agents: [
			{
				id: "worker",
				name: "worker",
				provider: "pi",
				cwd: root,
				args: [],
				env: {},
				profile: { identity: "profile", allowedTools, writePaths: [] },
			},
		],
	});
	return { root, store };
}

it("enforces report capability at reservation even without a configured peer command", async () => {
	const { store } = await fixture(["read"]);
	expect(() => store.reserveTurn("job-one", "worker", "read one file")).toThrow(/already-granted/);
	expect(store.load("job-one").agents[0]).toMatchObject({ turn: 0, status: "idle" });
});

it("reserves once, fences stale/replayed terminals, and preserves peer state", async () => {
	const { store } = await fixture();
	const first = store.reserveTurn("job-one", "worker", "first");
	expect(() => store.reserveTurn("job-one", "worker", "duplicate")).toThrow("pending");
	expect(store.finishTurn("job-one", "worker", "wrong", "done", "stale")).toBe(false);
	expect(store.finishTurn("job-one", "worker", first.turnId, "done", "evidence")).toBe(true);
	expect(store.finishTurn("job-one", "worker", first.turnId, "failed", "replay")).toBe(false);
	store.setVariable("job-one", "decision", "go");
	const second = store.reserveTurn("job-one", "worker", "second");
	expect(second.turn).toBe(2);
	expect(store.finishTurn("job-one", "worker", first.turnId, "done", "late")).toBe(false);
	expect(store.load("job-one").variables).toEqual({ decision: "go" });
	expect(store.load("job-one").agents[0].status).toBe("reserved");
});

it("denies traversal and cross-parent access without exposing another session's jobs", async () => {
	const { root, store } = await fixture();
	expect(() => store.load("../job-one")).toThrow();
	const foreign = new CollaborationJobStore(root, "foreign");
	expect(() => foreign.load("job-one")).toThrow("parent");
	expect(foreign.list()).toEqual([]);
	expect(store.list()).toHaveLength(1);
});

it("claims an uncertain prompt only once across independent store instances", async () => {
	const { root, store } = await fixture();
	const turn = store.reserveTurn("job-one", "worker", "once");
	const other = new CollaborationJobStore(root, "parent");
	expect(store.claimTurn("job-one", "worker", turn.turnId, 10)).toBe(true);
	expect(other.claimTurn("job-one", "worker", turn.turnId, 11)).toBe(false);
	expect(other.load("job-one").agents[0].helperPid).toBe(10);
});

it("surfaces corrupt records rather than hiding them as foreign jobs", async () => {
	const { store } = await fixture();
	const job = store.load("job-one");
	await writeFile(store.path("job-one"), JSON.stringify({ ...job, deadlineSeconds: -1 }));
	expect(() => store.list()).toThrow("Invalid collaboration job");
});

it("rejects mutations of immutable job and launch-profile ownership atomically", async () => {
	const { store } = await fixture();
	const before = await readFile(store.path("job-one"), "utf8");
	expect(() =>
		store.update("job-one", (job) => {
			job.id = "renamed";
		}),
	).toThrow(/immutable/i);
	expect(() =>
		store.update("job-one", (job) => {
			job.agents[0].profile = { ...job.agents[0].profile, writePaths: ["/"] };
		}),
	).toThrow(/immutable/i);
	expect(await readFile(store.path("job-one"), "utf8")).toBe(before);
});

it("does not rewrite durable state for stale or duplicate terminal events", async () => {
	const { store } = await fixture();
	const turn = store.reserveTurn("job-one", "worker", "first");
	store.finishTurn("job-one", "worker", turn.turnId, "done", "done");
	await utimes(store.path("job-one"), 1, 1);
	expect(store.finishTurn("job-one", "worker", turn.turnId, "failed", "replayed")).toBe(false);
	expect((await stat(store.path("job-one"))).mtimeMs).toBe(1000);
});

it("does not claim an expired reservation or replace a question with an ordinary prompt", async () => {
	const { store } = await fixture();
	const turn = store.reserveTurn("job-one", "worker", "first");
	store.update("job-one", (job) => {
		job.agents[0].deadlineAt = 1;
	});
	expect(store.claimTurn("job-one", "worker", turn.turnId, 10)).toBe(false);
	store.finishTurn("job-one", "worker", turn.turnId, "blocked", "Which branch?");
	expect(() => store.reserveTurn("job-one", "worker", "unrelated")).toThrow(/answer/i);
	const answered = store.reserveTurn("job-one", "worker", "feature branch", true);
	expect(answered.turnId).not.toBe(turn.turnId);
	expect(answered.profile).toEqual(turn.profile);
	expect(answered.prompt).toBe("feature branch");
});

it("archives only inactive jobs into a bounded recoverable record", async () => {
	const { store } = await fixture();
	const turn = store.reserveTurn("job-one", "worker", "first");
	expect(() => store.archive("job-one")).toThrow(/active/i);
	store.finishTurn("job-one", "worker", turn.turnId, "done", "verified");
	expect(() => store.archive("job-one")).toThrow(/handoff/i);
	store.update("job-one", (job) => {
		job.agents[0].notifiedTurn = turn.turn;
	});
	const archive = store.archive("job-one");
	expect(JSON.parse(await readFile(archive, "utf8"))).toMatchObject({ id: "job-one", parentSessionId: "parent" });
	expect(store.list()).toEqual([]);
});

it("does not archive a pending question even after its parent received the handoff", async () => {
	const { store } = await fixture();
	const turn = store.reserveTurn("job-one", "worker", "first");
	store.finishTurn("job-one", "worker", turn.turnId, "blocked", "Which branch?");
	store.update("job-one", (job) => {
		job.agents[0].notifiedTurn = turn.turn;
	});
	expect(() => store.archive("job-one")).toThrow(/question|active/i);
	store.dismiss("job-one");
	expect(store.archive("job-one")).toContain("archive");
});

it("bounds terminal evidence by UTF-8 bytes without breaking code points", () => {
	expect(boundCollaborationEvidence("bounded")).toBe("bounded");
	const evidence = boundCollaborationEvidence("界😀".repeat(2000));
	expect(Buffer.byteLength(evidence)).toBeLessThanOrEqual(8192);
	expect(evidence).toMatch(/\n…$/);
	expect(evidence).not.toContain("�");
});

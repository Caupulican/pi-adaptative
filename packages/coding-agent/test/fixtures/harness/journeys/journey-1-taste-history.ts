import { expect } from "vitest";
import { KnowledgeStore } from "../../../../src/core/memory/knowledge-store.ts";
import {
	countOwnerCommitsAfter,
	REPOSITORY_HISTORY_ORIGIN,
	readOwnerHistory,
	UNINFORMATIVE_PATHSPECS,
} from "../../../../src/core/memory/repository-history.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, projectPath } from "../session-fixture.ts";

/** The identity this phase configures, and one whose address contains it: the case a bare author filter merges. */
const OWNER_EMAIL = "owner@example.test";
const CONTAINING_EMAIL = `a${OWNER_EMAIL}`;
/** An obviously fake credential assignment: the reader must return none of its value. */
const FAKE_SECRET = "API_KEY=abc123fakevalue";
/** Lines per wide file: two file diffs fit the per-commit character bound and the third does not. */
const WIDE_FILE_LINES = 90;

/**
 * Part of journey 1, near its end: the owner's own commits, read the way the mining task will read them. The root is a
 * repository long before this phase -- the proactivity phase made it one -- so the phase initialises nothing: it
 * configures the owner identity and adds its commits on top of the current head, staging only the files it wrote so
 * nothing another leg left untracked is committed here. Host only: no model turn, and the reader runs its default
 * runner, so every command crosses the world's process layer to the virtual git.
 */
export async function runJourney1TasteHistoryPhase(world: HarnessWorld): Promise<void> {
	const cwd = HARNESS_PROJECT_CWD;
	const before = world.git.refSha("refs/heads/main");
	if (before === undefined) throw new Error("This phase reads a repository the journey made earlier");
	world.git.configureIdentity(OWNER_EMAIL);
	const write = (path: readonly string[], text: string): string => {
		world.io.seed(projectPath(...path), text);
		return path.join("/");
	};
	const commit = (message: string, files: readonly string[], options: readonly string[] = []): void => {
		expect(world.git.run(["add", "--", ...files], cwd).code).toBe(0);
		expect(world.git.run([...options, "commit", "-m", message], cwd).code).toBe(0);
	};

	// A lock file beside a source file: the lock teaches nothing about how the owner writes and is not read.
	commit("Add the answer", [
		write(["package-lock.json"], '{"lockfileVersion": 3}\n'),
		write(["src", "taste", "history", "answer.ts"], "export const answer = 42;\n"),
	]);
	commit("Read the key from the environment", [
		write(["src", "taste", "history", "config.ts"], `export const settings = "${FAKE_SECRET}";\n`),
	]);
	commit(
		"Add three wide modules",
		[0, 1, 2].map((index) => {
			const lines = Array.from(
				{ length: WIDE_FILE_LINES },
				(_, line) => `export const value${index}_${line} = ${line};`,
			);
			return write(["src", "taste", "history", `wide${index}.ts`], `${lines.join("\n")}\n`);
		}),
	);
	commit(
		"Add a guest module",
		[write(["src", "taste", "history", "guest.ts"], "export const guest = 1;\n")],
		["-c", `user.email=${CONTAINING_EMAIL}`, "-c", "user.name=Another Author"],
	);

	const mark = world.processes.gitCalls.length;
	const sample = await readOwnerHistory({ cwd });
	if (sample.status !== "sample") throw new Error(`The owner's commits were not read: ${sample.reason}`);
	// The repository held commits before this phase, made with no identity, and the guest's address only contains the
	// owner's: the sample holds exactly the phase's own three commits.
	expect(world.git.run(["rev-list", "--count", `${before}..HEAD`], cwd).stdout.trim()).toBe("4");
	expect(sample.head).toBe(world.git.refSha("refs/heads/main"));
	expect(sample.identity).toBe(OWNER_EMAIL);
	expect(sample.commits.map((entry) => entry.subject)).toEqual([
		"Add three wide modules",
		"Read the key from the environment",
		"Add the answer",
	]);
	expect(sample.omittedCommits).toBe(0);
	const [wide, secret, answer] = sample.commits;
	expect(answer?.patch, "the lock file teaches nothing about how the owner writes").not.toContain("package-lock.json");
	expect(answer?.patch).toContain("diff --git a/src/taste/history/answer.ts b/src/taste/history/answer.ts");
	expect(answer?.patch).toContain("+export const answer = 42;");
	expect(secret?.patch, "no secret-shaped text from history leaves the reader").not.toContain("abc123fakevalue");
	expect(secret?.patch).toContain("[REDACTED]");
	expect(wide?.patch.length).toBeLessThanOrEqual(6_000);
	expect(wide?.patch.match(/^diff --git /gm), "whole file diffs only, never a partial one").toHaveLength(2);
	expect(wide?.patch).toContain("1 file diff left out");

	const oldest = sample.commits.at(-1)!;
	expect(await countOwnerCommitsAfter({ cwd, after: oldest.id })).toEqual({ status: "counted", count: 2 });
	expect(await countOwnerCommitsAfter({ cwd, after: "0".repeat(40) })).toEqual({
		status: "unknown",
		reason: "unknown_commit",
	});

	// The reader's own commands: no shell, no credential prompt, the owner named between brackets, and the exclusions.
	const calls = world.processes.gitCalls.slice(mark);
	expect(calls.length).toBeGreaterThan(0);
	expect(calls.every((call) => call.operation === "spawn" && call.file === "git")).toBe(true);
	expect(calls.every((call) => call.env.GIT_TERMINAL_PROMPT === "0")).toBe(true);
	expect(calls.find((call) => call.args[0] === "log")?.args).toEqual(
		expect.arrayContaining(["--no-merges", "--fixed-strings", `--author=<${OWNER_EMAIL}>`]),
	);
	expect(calls.find((call) => call.args[0] === "show")?.args).toEqual(
		expect.arrayContaining([...UNINFORMATIVE_PATHSPECS]),
	);
	expect(calls.find((call) => call.args[0] === "rev-list")?.args).toEqual(
		expect.arrayContaining(["--count", "--no-merges", `--author=<${OWNER_EMAIL}>`]),
	);

	// What the origin looked at is remembered, so the next look reads only what is new.
	const store = KnowledgeStore.open(`${world.agentDir}-taste-history`);
	try {
		store.originLooks.record("", REPOSITORY_HISTORY_ORIGIN, sample.head);
		expect(store.originLooks.last("", REPOSITORY_HISTORY_ORIGIN)?.cursor).toBe(sample.head);
	} finally {
		store.close();
	}
	world.trace.mark("root", "taste.history.done");
}

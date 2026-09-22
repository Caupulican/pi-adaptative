import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileExecutionCharter } from "../../src/core/autonomy/execution-charter.ts";
import { executeDelivery } from "../../src/core/objective-execution/delivery-coordinator.ts";
import {
	candidateTreeDigest,
	createRepoGitDelivery,
	proveCommitAndPush,
} from "../../src/core/objective-execution/delivery-proof.ts";
import { createRepoReleaseDelivery } from "../../src/core/objective-execution/release-delivery.ts";
import { SystemOneController, TerminalHookRejectedError } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";
import { IntegrityHookCoordinator } from "../../src/core/system-one/integrity-hooks.ts";

function gitRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-blast-"));
	execFileSync("git", ["init"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
	execFileSync("git", ["config", "user.name", "test"], { cwd: root });
	execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
	execFileSync("git", ["config", "tag.gpgsign", "false"], { cwd: root });
	writeFileSync(join(root, "README.md"), "one\n");
	execFileSync("git", ["add", "README.md"], { cwd: root });
	execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "init"], { cwd: root });
	return root;
}

function head(root: string): string {
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

describe("delivery authority blast radius", () => {
	it("delivers from a tree that was already dirty, and leaves that pre-existing work alone", async () => {
		const root = gitRepo();
		const admitted = head(root);
		writeFileSync(join(root, "owner.txt"), "owner\n");
		const dirty = createRepoGitDelivery(root);
		writeFileSync(join(root, "README.md"), "objective\n");
		const certified = await dirty.certifyOwnedCandidate(["README.md"]);
		const committed = await dirty.commit({
			message: "objective",
			paths: ["README.md"],
			approvedParent: certified.parent,
			approvedTreeOid: certified.tree,
		});
		expect(committed.parent).toBe(admitted);
		// The pre-existing path was another session's work: never committed, never touched.
		const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
		expect(status).toContain("owner.txt");
		expect(status).not.toContain("README.md");
		const files = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: root, encoding: "utf8" });
		expect(files.trim()).toBe("README.md");

		// A path this objective did not produce, and that was not there at admission, still refuses.
		writeFileSync(join(root, "stranger.txt"), "foreign\n");
		await expect(dirty.certifyOwnedCandidate(["README.md"])).rejects.toThrow("delivery_unsafe_unowned_changes");

		const cleanRoot = gitRepo();
		const clean = createRepoGitDelivery(cleanRoot);
		const admittedClean = head(cleanRoot);
		writeFileSync(join(cleanRoot, "README.md"), "objective\n");
		writeFileSync(join(cleanRoot, "other.txt"), "foreign\n");
		await expect(clean.certifyOwnedCandidate(["README.md"])).rejects.toThrow("delivery_unsafe_unowned_changes");
		expect(head(cleanRoot)).toBe(admittedClean);
	});

	it("refuses a commit when an owned file changes after certification", async () => {
		const root = gitRepo();
		const delivery = createRepoGitDelivery(root);
		const admitted = head(root);
		writeFileSync(join(root, "README.md"), "two\n");
		const certified = await delivery.certifyOwnedCandidate(["README.md"]);
		writeFileSync(join(root, "README.md"), "three\n");
		await expect(
			delivery.commit({
				message: "two",
				paths: ["README.md"],
				approvedParent: certified.parent,
				approvedTreeOid: certified.tree,
			}),
		).rejects.toThrow("candidate_tree_mismatch");
		expect(head(root)).toBe(admitted);
	});

	it("binds commit proof to the approved parent and tree", () => {
		const tree = "tree-approved";
		const proven = proveCommitAndPush({
			commitRequired: true,
			pushRequired: false,
			reportedCommitSha: "sha-1",
			candidateDigest: candidateTreeDigest(tree),
			candidateRevision: "parent-1",
			approvedTreeOid: tree,
			approvedParent: "parent-1",
			observation: {
				head: "sha-1",
				parent: "parent-1",
				tree,
				remote: "",
				ref: "",
				observedSha: "",
				attributableResidue: [],
			},
		});
		expect(proven.commit?.state).toBe("proven");
		const drifted = proveCommitAndPush({
			commitRequired: true,
			pushRequired: false,
			reportedCommitSha: "sha-1",
			candidateDigest: candidateTreeDigest(tree),
			candidateRevision: "parent-1",
			approvedTreeOid: tree,
			approvedParent: "parent-1",
			observation: {
				head: "sha-1",
				parent: "parent-1",
				tree: "other-tree",
				remote: "",
				ref: "",
				observedSha: "",
				attributableResidue: [],
			},
		});
		expect(drifted.commit?.state).toBe("failed");
		if (drifted.commit?.state === "failed") expect(drifted.commit.error).toBe("candidate_tree_mismatch");
	});

	it("rejects a dirty push that has no commit", () => {
		const pushed = proveCommitAndPush({
			commitRequired: false,
			pushRequired: true,
			reportedPushRef: "refs/heads/main",
			reportedPushRemote: "origin",
			candidateRevision: "head-1",
			observation: {
				head: "head-1",
				parent: "older",
				tree: "tree",
				remote: "origin",
				ref: "refs/heads/main",
				observedSha: "head-1",
				attributableResidue: ["dirty.ts"],
			},
		});
		expect(pushed.push?.state).toBe("failed");
		if (pushed.push?.state === "failed") expect(pushed.push.error).toBe("commit_required_for_dirty_candidate");
	});

	it("does not retarget a push when the upstream changes", async () => {
		const root = gitRepo();
		const bare = mkdtempSync(join(tmpdir(), "pi-blast-remote-"));
		execFileSync("git", ["init", "--bare"], { cwd: bare });
		execFileSync("git", ["remote", "add", "origin", bare], { cwd: root });
		const delivery = createRepoGitDelivery(root);
		writeFileSync(join(root, "README.md"), "two\n");
		const certified = await delivery.certifyOwnedCandidate(["README.md"]);
		await delivery.commit({
			message: "two",
			paths: ["README.md"],
			approvedParent: certified.parent,
			approvedTreeOid: certified.tree,
		});
		const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
		execFileSync("git", ["config", `branch.${branch}.remote`, "origin"], { cwd: root });
		execFileSync("git", ["config", `branch.${branch}.merge`, `refs/heads/${branch}`], { cwd: root });
		const frozen = { remote: "origin", ref: `refs/heads/${branch}` };
		execFileSync("git", ["config", `branch.${branch}.remote`, "elsewhere"], { cwd: root });
		await expect(delivery.push(frozen)).rejects.toThrow("push_upstream_drift");
		expect(
			execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/heads"], {
				cwd: bare,
				encoding: "utf8",
			}).trim(),
		).toBe("");
	});

	it("requires an exact tag name and does not invent objective", async () => {
		const root = gitRepo();
		const delivery = createRepoGitDelivery(root);
		await expect(delivery.tag("")).rejects.toThrow("tag_name_required");
		expect(execFileSync("git", ["tag", "--list"], { cwd: root, encoding: "utf8" })).not.toContain("objective");
		const charter = compileExecutionCharter({ objectiveId: "obj", prompt: "tag the build" });
		expect(charter.git.create_tag).toBe(false);
		const named = compileExecutionCharter({ objectiveId: "obj", prompt: "create tag v1.2.3" });
		expect(named.delivery.git.tag).toEqual({ exact: true, name: "v1.2.3", push: false });
	});

	it("does not let a deploy script become a privileged adapter", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-blast-deploy-"));
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ private: true, scripts: { deploy: "echo owned", "deploy:status": "echo id" } }),
		);
		expect(createRepoReleaseDelivery(root)).toBeUndefined();
	});

	it("fails a requested GitHub release as unsupported", async () => {
		const charter = compileExecutionCharter({
			objectiveId: "obj",
			prompt: "create release",
			initialGrants: { release: { github_repository: "Caupulican/pi-adaptative", github_tag: "v1.2.3" } },
		});
		expect(charter.release.github_release).toBe(true);
		const sideEffects = await executeDelivery({
			charter,
			candidateUntrackedPaths: [],
			attributedPaths: [],
		});
		expect(sideEffects.github_release?.state).toBe("failed");
		if (sideEffects.github_release?.state === "failed") {
			expect(sideEffects.github_release.error).toBe("github_release_unsupported");
		}
	});

	it("rejects publish when the manifest identity drifts from admission", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-blast-pkg-"));
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pkg", version: "1.0.0" }));
		const delivery = createRepoReleaseDelivery(root, {
			packageIntent: { packageName: "pkg", version: "1.0.0", registry: "https://registry.example.test" },
		});
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pkg", version: "9.9.9" }));
		await expect(delivery?.publish?.()).rejects.toThrow("package_identity_mismatch");
	});

	it("does not store complete when the terminal hook refuses", async () => {
		const store = new ExecutionStore({
			run_id: "run-terminal",
			objective: { request: "do it", normalized_goal: "do it", acceptance_criteria: [] },
			repo: { root: "/workspace", baseline_revision: "r0" },
		});
		let impact = "";
		const hooks = new IntegrityHookCoordinator([
			{
				id: "terminal-guard",
				onHook: async (hook, context) => {
					if (hook === "terminal") impact = context.impact;
					return { decision: "deny", reasonCodes: ["refused"], validationRefs: [] };
				},
			},
		]);
		const systemOne = new SystemOneController({
			store,
			adapter: {
				provenance: "native_calibrated",
				evaluate: async () => ({ model: "m", answers: {}, latency_ms: 1 }),
			},
			hookCoordinator: hooks,
		});
		await expect(
			systemOne.commitTerminalCompletion({ objectiveId: "obj-1", candidateDigest: "digest" }),
		).rejects.toBeInstanceOf(TerminalHookRejectedError);
		expect(store.phase).not.toBe("complete");
		expect(impact).toBe("read_only");
	});
});

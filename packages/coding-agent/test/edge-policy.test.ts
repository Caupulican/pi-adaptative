import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	classifyAllEdgeOperations,
	classifyEdgeOperation,
	collectEdgeGrants,
	EDGE_CLASSES,
	EDGE_CONFIRMATION_REQUIRED,
	EDGE_GRANT_CUSTOM_TYPE,
	EDGE_REVOKE_CUSTOM_TYPE,
	edgeBlockReason,
	shellInvocations,
} from "../src/core/autonomy/edge-policy.ts";

const task = resolve("/work/project");
const agentDir = resolve("/home/op/.pi/agent");

function classify(command: string, cwd = task) {
	return classifyEdgeOperation({ toolName: "bash", args: { command }, cwd, scopeCwd: task, agentDir })?.class;
}

describe("edge policy classification", () => {
	it("names the edge classes and nothing else", () => {
		expect([...EDGE_CLASSES]).toEqual([
			"git.publish",
			"package.publish",
			"package.install",
			"destructive.fs",
			"settings.authority",
			"toolkit.script",
		]);
	});

	it.each([
		["rm -rf /", "destructive.fs"],
		["rm -rf ~", "destructive.fs"],
		["rm -rf .", "destructive.fs"],
		["rm -rf .git", "destructive.fs"],
		["rm -rf /work/project", "destructive.fs"],
		["rm -rf /work/project/.git", "destructive.fs"],
		["gh repo delete owner/name --yes", "destructive.fs"],
		["dd if=/dev/zero of=/dev/sda", "destructive.fs"],
		["mkfs.ext4 /dev/sdb", "destructive.fs"],
		["find . -delete", "destructive.fs"],
		["find / -delete", "destructive.fs"],
	] as const)("%s → %s", (command, expected) => {
		expect(classify(command)).toBe(expected);
	});

	it.each([
		"git status",
		"git log --oneline -n 5",
		"git diff HEAD~1",
		"git commit -m 'wip'",
		"git tag -l",
		"git tag --list 'v*'",
		"git reset --soft HEAD~1",
		"git reset src/a.ts",
		"git checkout feature-branch",
		"git restore --staged src/a.ts",
		"git stash",
		"git stash pop",
		"git clean -n",
		"gh pr list",
		"gh release list",
		"npm install",
		"npm ci",
		"npm run build",
		"npm test",
		"pnpm install",
		"pip install -r requirements.txt",
		"pip install -e .",
		"git push origin main",
		"git tag v1.2.3",
		"git reset --hard HEAD~1",
		"git clean -fdx",
		"git checkout .",
		"npm publish --access public",
		"npm install left-pad",
		"rm -rf node_modules",
		"rm -rf dist",
		"rm -rf ../other-project",
		"rm /etc/hosts",
		"rm src/old.ts",
		"rm -rf ./build && npm run build",
		"find . -name '*.tmp' -delete",
		"find /var/log -name '*.log' -delete",
		"find /var/log -delete",
		"ls -la",
		"echo hello > out.txt",
		"sed -i 's/a/b/' src/a.ts",
	])("ordinary work runs: %s", (command) => {
		expect(classify(command)).toBeUndefined();
	});

	it("keeps deletions inside the task directory ordinary when the call runs in a subdirectory", () => {
		expect(classify("rm -rf ../build", join(task, "packages"))).toBeUndefined();
		expect(classify("rm -rf ../../elsewhere", join(task, "packages"))).toBeUndefined();
		expect(classify("rm -rf ..", join(task, "packages"))).toBe("destructive.fs");
		expect(classify("rm -rf ../..", join(task, "packages"))).toBe("destructive.fs");
	});

	it("does not ask before writing the harness's own authority files", () => {
		const settings = join(agentDir, "settings.json");
		expect(
			classifyEdgeOperation({
				toolName: "write",
				args: { path: settings, content: "{}" },
				cwd: task,
				scopeCwd: task,
				agentDir,
			})?.class,
		).toBeUndefined();
		expect(classify(`sed -i 's/x/y/' ${settings}`)).toBeUndefined();
		expect(classify(`echo '{}' > ${settings}`)).toBeUndefined();
	});

	it("reads through prefixes and connectors, and falls back when the parser refuses the line", () => {
		expect(classify("cd packages && FOO=1 sudo git push")).toBeUndefined();
		expect(classify("git push $(git rev-parse --abbrev-ref HEAD)")).toBeUndefined();
		expect(shellInvocations("git status; git push").map((argv) => argv[0])).toEqual(["git", "git"]);
	});

	it("leaves a worktree discard ordinary until the caller says other work is in the tree", () => {
		const conditional = (command: string) =>
			classifyAllEdgeOperations(
				{ toolName: "bash", args: { command }, cwd: task, scopeCwd: task, agentDir },
				{ includeConditional: true },
			);
		for (const command of [
			"git reset --hard HEAD~1",
			"git reset --merge",
			"git clean -fdx",
			"git checkout .",
			"git checkout -- src",
			"git restore src/a.ts",
			"git stash",
			"git stash save wip",
			"git stash drop",
			"git stash clear",
			"git -C /work/project reset --hard",
		]) {
			// Nothing by default: a caller that cannot tell whose work is in the tree must not ask.
			expect(classify(command), command).toBeUndefined();
			const [operation] = conditional(command);
			expect(operation?.class, command).toBe("destructive.fs");
			expect(operation?.condition, command).toBe("unowned_worktree_changes");
		}
	});

	it("keeps git that does not discard the worktree ordinary even for a caller that resolves conditions", () => {
		for (const command of [
			"git status",
			"git commit -m wip",
			"git push origin main",
			"git reset --soft HEAD~1",
			"git reset src/a.ts",
			"git checkout feature-branch",
			"git restore --staged src/a.ts",
			"git stash pop",
			"git stash list",
			"git clean -n",
		]) {
			expect(
				classifyAllEdgeOperations(
					{ toolName: "bash", args: { command }, cwd: task, scopeCwd: task, agentDir },
					{ includeConditional: true },
				),
				command,
			).toEqual([]);
		}
	});

	it("does not classify a home directory delete as ordinary because the task lives under it", () => {
		const home = resolve(homedir());
		expect(
			classifyEdgeOperation({
				toolName: "bash",
				args: { command: `rm -rf ${home}` },
				cwd: home,
				scopeCwd: home,
				agentDir,
			})?.class,
		).toBe("destructive.fs");
	});
});

describe("edge grants", () => {
	const grant = (cls: string, source: "operator" | "instructions", extra: Record<string, unknown> = {}) => ({
		type: "custom" as const,
		customType: EDGE_GRANT_CUSTOM_TYPE,
		data: { version: 1, class: cls, source, grantedAt: "2026-09-10T00:00:00.000Z", ...extra },
	});
	const revoke = (cls: string) => ({
		type: "custom" as const,
		customType: EDGE_REVOKE_CUSTOM_TYPE,
		data: { version: 1, class: cls },
	});

	it("replays grant and revoke records in order over the machine's standing grants", () => {
		const grants = collectEdgeGrants(
			[
				grant("git.publish", "instructions", { quote: "push when done" }),
				grant("package.install", "operator", { note: "ok" }),
				revoke("package.install"),
				{ type: "message" as const },
				grant("package.install", "operator"),
				revoke("destructive.fs"),
			],
			["destructive.fs", "not-a-class"],
		);
		expect(grants).toEqual([
			{ class: "destructive.fs", source: "settings" },
			{
				class: "git.publish",
				source: "instructions",
				quote: "push when done",
				grantedAt: "2026-09-10T00:00:00.000Z",
			},
			{ class: "package.install", source: "operator", grantedAt: "2026-09-10T00:00:00.000Z" },
		]);
	});

	it("ignores malformed records and never lets a branch record override a settings grant", () => {
		const grants = collectEdgeGrants(
			[
				{ type: "custom" as const, customType: EDGE_GRANT_CUSTOM_TYPE, data: { version: 2, class: "git.publish" } },
				{
					type: "custom" as const,
					customType: EDGE_GRANT_CUSTOM_TYPE,
					data: { version: 1, class: "nope", source: "operator" },
				},
				grant("git.publish", "operator", { note: "session" }),
			],
			["git.publish"],
		);
		expect(grants).toEqual([{ class: "git.publish", source: "settings" }]);
	});

	it("names every way to grant in the block reason", () => {
		const reason = edgeBlockReason(
			{ class: "git.publish", operation: "git push", reason: "pushes commits to a remote" },
			false,
		);
		expect(reason).toContain("goal grant_edge");
		expect(reason).toContain("/edge allow git.publish");
		expect(reason).toContain(EDGE_CONFIRMATION_REQUIRED);
		expect(edgeBlockReason({ class: "git.publish", operation: "git push", reason: "x" }, true)).toContain("declined");
		// The failure ledger shows a bounded diagnostic; every pointer sits inside its first 200 characters.
		expect(reason.indexOf("/edge allow git.publish")).toBeLessThan(200);
		expect(reason.indexOf("goal grant_edge")).toBeLessThan(200);
	});
});

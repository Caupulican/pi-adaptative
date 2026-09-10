import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
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
		]);
	});

	it.each([
		["git push origin main", "git.publish"],
		["git -C /work/project push --force", "git.publish"],
		["git status && git push", "git.publish"],
		["git tag v1.2.3", "git.publish"],
		["gh release create v1.2.3 --notes x", "git.publish"],
		["gh pr merge 12 --squash", "git.publish"],
		["npm publish --access public", "package.publish"],
		["pnpm publish", "package.publish"],
		["cargo publish", "package.publish"],
		["twine upload dist/*", "package.publish"],
		["docker push registry/image:tag", "package.publish"],
		["npm install left-pad", "package.install"],
		["npm i -g typescript", "package.install"],
		["pnpm add -D vitest", "package.install"],
		["yarn add react", "package.install"],
		["pip install requests", "package.install"],
		["uv add httpx", "package.install"],
		["cargo add serde", "package.install"],
		["go get github.com/x/y@latest", "package.install"],
		["brew install jq", "package.install"],
		["git reset --hard HEAD~1", "destructive.fs"],
		["git clean -fdx", "destructive.fs"],
		["git checkout -- src/a.ts", "destructive.fs"],
		["git checkout .", "destructive.fs"],
		["git restore src/a.ts", "destructive.fs"],
		["git stash drop", "destructive.fs"],
		["rm -rf /", "destructive.fs"],
		["rm -rf ~", "destructive.fs"],
		["rm -rf ../other-project", "destructive.fs"],
		["rm /etc/hosts", "destructive.fs"],
		["find /var/log -name '*.log' -delete", "destructive.fs"],
		["dd if=/dev/zero of=/dev/sda", "destructive.fs"],
		["Remove-Item -Recurse -Force C:\\Users\\op\\Documents", "destructive.fs"],
		["sudo -u root rm -rf /var/lib/app", "destructive.fs"],
		["nohup npm publish", "package.publish"],
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
		"rm -rf node_modules",
		"rm -rf dist",
		"rm src/old.ts",
		"rm -rf ./build && npm run build",
		"find . -name '*.tmp' -delete",
		"ls -la",
		"echo hello > out.txt",
		"sed -i 's/a/b/' src/a.ts",
	])("ordinary work runs: %s", (command) => {
		expect(classify(command)).toBeUndefined();
	});

	it("keeps deletions inside the task directory ordinary when the call runs in a subdirectory", () => {
		expect(classify("rm -rf ../build", join(task, "packages"))).toBeUndefined();
		expect(classify("rm -rf ../../elsewhere", join(task, "packages"))).toBe("destructive.fs");
	});

	it("treats writes to the harness's own authority files as the settings edge", () => {
		const settings = join(agentDir, "settings.json");
		expect(
			classifyEdgeOperation({
				toolName: "write",
				args: { path: settings, content: "{}" },
				cwd: task,
				scopeCwd: task,
				agentDir,
			})?.class,
		).toBe("settings.authority");
		expect(
			classifyEdgeOperation({
				toolName: "edit",
				args: { path: ".pi/settings.json" },
				cwd: task,
				scopeCwd: task,
				agentDir,
			})?.class,
		).toBe("settings.authority");
		expect(classify(`sed -i 's/x/y/' ${settings}`)).toBe("settings.authority");
		expect(classify(`echo '{}' > ${settings}`)).toBe("settings.authority");
		expect(classify(`cat ${settings}`)).toBeUndefined();
		expect(
			classifyEdgeOperation({
				toolName: "write",
				args: { path: "src/settings.json", content: "{}" },
				cwd: task,
				scopeCwd: task,
				agentDir,
			})?.class,
		).toBeUndefined();
	});

	it("reads through prefixes and connectors, and falls back when the parser refuses the line", () => {
		expect(classify("cd packages && FOO=1 sudo git push")).toBe("git.publish");
		expect(classify("git push $(git rev-parse --abbrev-ref HEAD)")).toBe("git.publish");
		expect(shellInvocations("git status; git push").map((argv) => argv[0])).toEqual(["git", "git"]);
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

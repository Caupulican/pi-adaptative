import { describe, expect, it } from "vitest";
import type { ExecutionCharter } from "../src/core/autonomy/execution-charter.ts";
import {
	applyLocalCommitCharter,
	commandPushesGit,
	refuseLocalPush,
	resolveDeliveryBinding,
	resolveRuleAuthority,
} from "../src/core/objective-execution/local-commit-delivery.ts";
import { ToolGateController } from "../src/core/tool-gate-controller.ts";

const policy = { branch: () => "feature" };

describe("local commit delivery", () => {
	it("puts the user above written rules, asks when they differ, and lets a handoff settle", () => {
		const base = { rulesDiffer: false, overridesWrittenRules: false, fullHandoff: false, requestHolds: false };
		expect(resolveRuleAuthority({ ...base, rulesDiffer: true })).toBe("ask");
		expect(resolveRuleAuthority({ ...base, overridesWrittenRules: true })).toBe("user");
		expect(resolveRuleAuthority({ ...base, rulesDiffer: true, fullHandoff: true, requestHolds: true })).toBe("user");
		expect(resolveRuleAuthority({ ...base, rulesDiffer: true, fullHandoff: true, requestHolds: false })).toBe(
			"written",
		);
		expect(resolveRuleAuthority(base)).toBe("unset");
	});

	it("lets the user block and lift the binding, and leaves it alone when they do neither", () => {
		expect(resolveDeliveryBinding(undefined, { blocksPush: true, liftsPushBlock: false }, "feature")).toBe("feature");
		expect(resolveDeliveryBinding("feature", { blocksPush: false, liftsPushBlock: true }, "feature")).toBeUndefined();
		expect(resolveDeliveryBinding("feature", { blocksPush: false, liftsPushBlock: false }, "other")).toBe("feature");
		expect(resolveDeliveryBinding("feature", { blocksPush: true, liftsPushBlock: true }, "other")).toBe("feature");
		expect(resolveDeliveryBinding(undefined, { blocksPush: true, liftsPushBlock: false }, undefined)).toBe("");
	});

	it("recognizes a real git push and ignores the words inside another command", () => {
		expect(commandPushesGit("git push origin HEAD")).toBe(true);
		expect(commandPushesGit("sudo git -C /tmp/repo push")).toBe(true);
		expect(commandPushesGit('git commit -m "do not push"')).toBe(false);
		expect(commandPushesGit("echo git push")).toBe(false);
		expect(commandPushesGit("git status")).toBe(false);
	});

	it("refuses the push for a bound policy and allows it when the policy is off", () => {
		expect(refuseLocalPush(policy, "bash", { command: "git push" })?.block).toBe(true);
		expect(refuseLocalPush(undefined, "bash", { command: "git push" })).toBeUndefined();
		expect(refuseLocalPush(policy, "bash", { command: "git commit -m x" })).toBeUndefined();
		expect(refuseLocalPush(policy, "run_process", { executable: "git", args: ["push"] })?.reason).toContain(
			"feature",
		);
	});

	it("turns a charter into local commits without a push", () => {
		const charter = {
			git: { commit: false, push: true, force_push: true, create_branch: false, create_tag: false },
			delivery: {
				git: { commit: false, push: { exact: true, remote: "origin", ref: "refs/heads/main" }, tag: false },
			},
		} as ExecutionCharter;
		const bound = applyLocalCommitCharter(charter);
		expect(bound.git.commit).toBe(true);
		expect(bound.git.push).toBe(false);
		expect(bound.git.force_push).toBe(false);
		expect(bound.delivery.git.push).toBe(false);
	});

	it("the root tool gate refuses git push only while the policy is bound", async () => {
		let branch: string | undefined;
		const gate = new ToolGateController({
			maybeEscalateToolCall: () => undefined,
			getCwd: () => "/work",
			getCapabilityEnvelope: () => undefined,
			recordGateOutcome: () => {},
			getExtensionRunner: () =>
				({
					hasHandlers: () => false,
					emitBeforeToolCall: async () => undefined,
					emitToolResult: async () => undefined,
				}) as never,
			localCommitBranch: () => branch,
		});
		const call = (command: string) =>
			gate.beforeToolCall(
				{
					assistantMessage: {
						provider: "test",
						model: "test",
						content: [],
						api: "openai-responses",
						usage: {},
						stopReason: "stop",
						timestamp: 0,
					},
					toolCall: { type: "toolCall", id: "c", name: "bash", arguments: { command } },
					args: { command },
				} as never,
				undefined,
			);
		branch = "feature";
		expect((await call("git push origin HEAD"))?.block).toBe(true);
		expect(await call("git commit -m x")).toBeUndefined();
		branch = undefined;
		expect(await call("git push origin HEAD")).toBeUndefined();
	});
});

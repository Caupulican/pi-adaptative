import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { describe, expect, it, vi } from "vitest";
import { enforceSessionEdge, type SessionEdgeDeps } from "../src/core/agent-session-edge.ts";
import { classifyYoloBoundary } from "../src/core/autonomy/edge-policy.ts";
import { createLaneToolSurface } from "../src/core/autonomy/lane-tool-surface.ts";

const cwd = "/tmp/pi-project";

function classify(command: string, denyCommands: readonly string[] = []) {
	return classifyYoloBoundary({ toolName: "bash", args: { command }, cwd, scopeCwd: cwd, denyCommands });
}

describe("YOLO execution boundary", () => {
	it("admits ordinary work and user-authorized publication without another approval", () => {
		expect(classify("git log -5")).toBeUndefined();
		expect(classify("git push --force origin main")).toBeUndefined();
		expect(classify("cd /tmp && git push origin main")).toBeUndefined();
		expect(classify("cd /tmp && git push --force origin main")).toBeUndefined();
		expect(classify("npm publish --tag beta")).toBeUndefined();
		expect(classify("cd /tmp && npm publish --tag beta")).toBeUndefined();
		expect(classify("echo 'rm -rf /'")).toBeUndefined();
	});

	it("requires a fresh owner decision for deleting the repository", () => {
		expect(classify("rm -rf .")).toMatchObject({ kind: "confirm", reason: "deletes the repository" });
		expect(classify("gh repo delete owner/project")).toMatchObject({ kind: "confirm" });
	});

	it("blocks catastrophic machine commands before YOLO", () => {
		for (const command of [
			"rm -rf /",
			"rm -rf $HOME",
			"rm -rf ~",
			"rm -rf /usr",
			"rm -rf /usr/",
			"rm -rf C:\\",
			"rm -rf C:/",
			"mkfs.ext4 /dev/sda",
			"dd if=/dev/zero of=/dev/sda",
			"shutdown now",
			"kill -9 -1",
			":(){ :|:& };:",
		]) {
			expect(classify(command), command).toMatchObject({ kind: "block" });
		}
	});

	it("honors explicit deny globs while preserving unrelated commands", () => {
		expect(classify("npm publish --tag beta", ["npm publish*"])).toMatchObject({
			kind: "block",
			reason: "user deny rule: npm publish*",
		});
		expect(classify("cd /tmp && npm publish --tag beta", ["npm publish*"])).toMatchObject({ kind: "block" });
		expect(classify("sudo npm publish --tag beta", ["npm publish*"])).toMatchObject({ kind: "block" });
		expect(classify("git log -5", ["npm publish*"])).toBeUndefined();
	});

	it("asks the owner for each repository deletion and never stores a standing grant", async () => {
		const confirmation = vi.fn(async () => "allow-session" as const);
		const appendCustomEntry = vi.fn();
		const deps: SessionEdgeDeps = {
			getMode: () => "yolo",
			getBranch: () => [],
			getEdgeRecords: () => [],
			getSettingsAllow: () => ["destructive.fs"],
			appendCustomEntry,
			getCwd: () => cwd,
			isChildSession: () => false,
			getConfirmation: () => confirmation,
		};
		expect(
			await enforceSessionEdge(deps, "bash", { command: "npm publish --tag beta" }, cwd, undefined),
		).toBeUndefined();
		expect(confirmation).not.toHaveBeenCalled();
		for (let index = 0; index < 2; index++) {
			expect(await enforceSessionEdge(deps, "bash", { command: "rm -rf ." }, cwd, undefined)).toBeUndefined();
		}
		expect(confirmation).toHaveBeenCalledTimes(2);
		expect(appendCustomEntry).not.toHaveBeenCalled();
	});

	it("blocks worker repository deletion without prompting the owner", async () => {
		const confirmation = vi.fn(async () => "allow-once" as const);
		const deps: SessionEdgeDeps = {
			getMode: () => "yolo",
			getBranch: () => [],
			getEdgeRecords: () => [],
			getSettingsAllow: () => ["destructive.fs"],
			appendCustomEntry: vi.fn(),
			getCwd: () => cwd,
			isChildSession: () => true,
			getConfirmation: () => confirmation,
		};
		expect(await enforceSessionEdge(deps, "bash", { command: "rm -rf ." }, cwd, undefined)).toMatchObject({
			block: true,
		});
		expect(confirmation).not.toHaveBeenCalled();
	});

	it("applies the same hardline and user deny rules to a YOLO worker", async () => {
		const surface = createLaneToolSurface({
			cwd,
			yolo: true,
			shellSessionKey: "yolo-boundary-test",
			denyCommands: ["npm publish*"],
		});
		const call = (command: string) => {
			const toolCall = fauxToolCall("bash", { command });
			return surface.beforeToolCall({
				assistantMessage: fauxAssistantMessage([toolCall]),
				toolCall,
				args: { command },
				context: { systemPrompt: "", messages: [], tools: surface.tools },
			});
		};
		try {
			expect(await call("git log -5")).toBeUndefined();
			expect(await call("git push origin main")).toBeUndefined();
			expect(await call("npm publish --tag beta")).toMatchObject({ block: true });
			expect(await call("rm -rf /")).toMatchObject({ block: true });
			expect(await call("rm -rf .")).toMatchObject({
				block: true,
				reason: expect.stringContaining("Owner approval"),
			});
		} finally {
			await surface.dispose();
		}
	});
});

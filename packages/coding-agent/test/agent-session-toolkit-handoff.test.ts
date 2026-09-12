import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import type { EdgeConfirmationRequest } from "../src/core/autonomy/edge-policy.ts";
import type { ToolkitScript } from "../src/core/toolkit/script-registry.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const isWin = process.platform === "win32";
const runner = isWin ? "powershell" : "bash";
const scriptFilename = isWin ? "safe-toolkit.ps1" : "safe-toolkit.sh";
const otherScriptFilename = isWin ? "other-toolkit.ps1" : "other-toolkit.sh";

function lastToolResult(harness: Harness) {
	const results = harness.session.agent.state.messages.filter((m) => m.role === "toolResult");
	return results[results.length - 1];
}

function lastToolResultText(harness: Harness): string {
	const last = lastToolResult(harness);
	if (last?.role !== "toolResult") throw new Error("no tool result found in messages");
	return last.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function createTestScripts(): ToolkitScript[] {
	return [
		{
			name: "safe-deploy",
			description: "Deploy the service",
			aliases: ["ship-it", "deploy-alias"],
			runner,
			path: scriptFilename,
			danger: true,
		},
		{
			name: "other-script",
			description: "Another registered script with different path",
			runner,
			path: otherScriptFilename,
			danger: true,
		},
		{
			name: "alternate-runner-script",
			description: "Different runner script",
			runner: "uv",
			path: "alternate.py",
			danger: true,
		},
	];
}

function writeHarmlessScripts(tempDir: string): void {
	const scriptContent = isWin
		? 'param($a, $b)\nWrite-Output "safe-output $a $b"\n'
		: '#!/usr/bin/env bash\necho "safe-output $1 $2"\n';
	const otherContent = isWin
		? 'param($a, $b)\nWrite-Output "other-output $a $b"\n'
		: '#!/usr/bin/env bash\necho "other-output $1 $2"\n';

	writeFileSync(join(tempDir, scriptFilename), scriptContent, { mode: 0o755 });
	writeFileSync(join(tempDir, otherScriptFilename), otherContent, { mode: 0o755 });
}

describe("agent-session toolkit handoff integration", () => {
	it("proves owner exact quote grants narrow toolkit scope and executes without confirmation", async () => {
		const harness = await createHarness({
			settings: {
				toolkit: {
					scripts: createTestScripts(),
				},
			},
		});
		writeHarmlessScripts(harness.tempDir);

		const confirmationRequests: EdgeConfirmationRequest[] = [];
		harness.session.setEdgeConfirmation(async (req) => {
			confirmationRequests.push(req);
			return "deny";
		});

		try {
			// 1. Negative control: before grant, dangerous script requires host confirmation
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("run_toolkit_script", {
							script: "safe-deploy",
							args: ["--prod"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Stopped at confirmation"),
			]);
			await harness.session.prompt("Try running without grant");
			expect(confirmationRequests).toHaveLength(1);
			expect(confirmationRequests[0]?.class).toBe("toolkit.script");
			expect(lastToolResultText(harness)).toContain("confirmation");

			// 2. Owner provides exact statement authorizing narrow script and args
			const ownerQuote = "Please deploy safe-deploy with --prod now";
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("goal", {
							action: "grant_edge",
							edgeClass: "toolkit.script",
							toolkitScript: "safe-deploy",
							toolkitArgs: ["--prod"],
							quote: ownerQuote,
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Grant recorded"),
			]);
			await harness.session.prompt(ownerQuote);

			const grantText = lastToolResultText(harness);
			expect(grantText).toContain("edge granted: toolkit.script [safe-deploy]");
			const grants = harness.session.getEdgeGrants();
			expect(grants).toHaveLength(1);
			expect(grants[0]).toMatchObject({
				class: "toolkit.script",
				source: "instructions",
				quote: ownerQuote,
			});
			expect(grants[0]?.scopeKey).toBeDefined();

			// 3. Execution with the granted narrow selector: executes without confirmation
			const confirmCountBefore = confirmationRequests.length;
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("run_toolkit_script", {
							script: "safe-deploy",
							args: ["--prod"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Deploy complete"),
			]);
			await harness.session.prompt("Proceed with deploy");

			expect(confirmationRequests).toHaveLength(confirmCountBefore);
			const execText = lastToolResultText(harness);
			expect(execText).toContain("safe-output --prod");
			const lastResult = lastToolResult(harness);
			expect((lastResult?.details as { outcome?: string })?.outcome).toBe("executed");
		} finally {
			await harness.cleanup();
		}
	});

	it("proves the same selector reuses grant on follow-up execution", async () => {
		const harness = await createHarness({
			settings: {
				toolkit: {
					scripts: createTestScripts(),
				},
			},
		});
		writeHarmlessScripts(harness.tempDir);

		const confirmationRequests: EdgeConfirmationRequest[] = [];
		harness.session.setEdgeConfirmation(async (req) => {
			confirmationRequests.push(req);
			return "deny";
		});

		try {
			const ownerQuote = "Run safe-deploy --prod right away";
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("goal", {
							action: "grant_edge",
							edgeClass: "toolkit.script",
							toolkitScript: "safe-deploy",
							toolkitArgs: ["--prod"],
							quote: ownerQuote,
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Grant recorded"),
			]);
			await harness.session.prompt(ownerQuote);

			// First execution: runs without confirmation
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("run_toolkit_script", {
							script: "safe-deploy",
							args: ["--prod"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Run 1 done"),
			]);
			await harness.session.prompt("First run");
			expect(confirmationRequests).toHaveLength(0);
			expect(lastToolResultText(harness)).toContain("safe-output --prod");

			// Second execution (same selector): reuses grant without confirmation
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("run_toolkit_script", {
							script: "safe-deploy",
							args: ["--prod"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Run 2 done"),
			]);
			await harness.session.prompt("Second run");
			expect(confirmationRequests).toHaveLength(0);
			expect(lastToolResultText(harness)).toContain("safe-output --prod");
		} finally {
			await harness.cleanup();
		}
	});

	it("proves changed argv or ungranted script name does not inherit the narrow grant", async () => {
		const harness = await createHarness({
			settings: {
				toolkit: {
					scripts: createTestScripts(),
				},
			},
		});
		writeHarmlessScripts(harness.tempDir);

		const confirmationRequests: EdgeConfirmationRequest[] = [];
		harness.session.setEdgeConfirmation(async (req) => {
			confirmationRequests.push(req);
			return "deny";
		});

		try {
			// Grant specifically: safe-deploy with ["--prod"]
			const ownerQuote = "Authorize safe-deploy --prod";
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("goal", {
							action: "grant_edge",
							edgeClass: "toolkit.script",
							toolkitScript: "safe-deploy",
							toolkitArgs: ["--prod"],
							quote: ownerQuote,
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Granted"),
			]);
			await harness.session.prompt(ownerQuote);

			// Negative control 1: changed argv ("--staging")
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("run_toolkit_script", {
							script: "safe-deploy",
							args: ["--staging"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Blocked changed argv"),
			]);
			await harness.session.prompt("Run with staging flag");
			expect(confirmationRequests).toHaveLength(1);
			expect(lastToolResultText(harness)).toContain("confirmation");

			// Negative control 2: changed argv (empty args)
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("run_toolkit_script", {
							script: "safe-deploy",
							args: [],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Blocked empty args"),
			]);
			await harness.session.prompt("Run without flags");
			expect(confirmationRequests).toHaveLength(2);
			expect(lastToolResultText(harness)).toContain("confirmation");

			// Negative control 3: different registered script name ("other-script" with ["--prod"])
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("run_toolkit_script", {
							script: "other-script",
							args: ["--prod"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Blocked other script"),
			]);
			await harness.session.prompt("Run other script");
			expect(confirmationRequests).toHaveLength(3);
			expect(lastToolResultText(harness)).toContain("confirmation");

			// Negative control 4: different registered runner script ("alternate-runner-script" with ["--prod"])
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("run_toolkit_script", {
							script: "alternate-runner-script",
							args: ["--prod"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Blocked alternate runner script"),
			]);
			await harness.session.prompt("Run alternate runner script");
			expect(confirmationRequests).toHaveLength(4);
			expect(lastToolResultText(harness)).toContain("confirmation");

			// Positive control: exact selector still works without confirmation
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("run_toolkit_script", {
							script: "safe-deploy",
							args: ["--prod"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Exact match executed"),
			]);
			await harness.session.prompt("Run exact match");
			expect(confirmationRequests).toHaveLength(4); // did not increase
			expect(lastToolResultText(harness)).toContain("safe-output --prod");
		} finally {
			await harness.cleanup();
		}
	});

	it("proves mutating registered script path or runner under fixed name and argv denies execution until restored", async () => {
		const harness = await createHarness({
			settings: {
				toolkit: {
					scripts: createTestScripts(),
				},
			},
		});
		writeHarmlessScripts(harness.tempDir);

		const confirmationRequests: EdgeConfirmationRequest[] = [];
		harness.session.setEdgeConfirmation(async (req) => {
			confirmationRequests.push(req);
			return "deny";
		});

		try {
			// 1. Grant specifically: canonical name "safe-deploy" with argv ["--prod"]
			const ownerQuote = "Authorize safe-deploy with --prod for deployment";
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("goal", {
							action: "grant_edge",
							edgeClass: "toolkit.script",
							toolkitScript: "safe-deploy",
							toolkitArgs: ["--prod"],
							quote: ownerQuote,
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Granted"),
			]);
			await harness.session.prompt(ownerQuote);
			expect(lastToolResultText(harness)).toContain("edge granted: toolkit.script [safe-deploy]");

			// Positive baseline: executes without confirmation under initial registration
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("run_toolkit_script", {
							script: "safe-deploy",
							args: ["--prod"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Initial run succeeded"),
			]);
			await harness.session.prompt("Run baseline");
			expect(confirmationRequests).toHaveLength(0);
			expect(lastToolResultText(harness)).toContain("safe-output --prod");

			// 2. Mutate registry path ONLY under same canonical name "safe-deploy" and fixed argv ["--prod"]
			harness.settingsManager.setToolkitSettings({
				scripts: [
					{
						name: "safe-deploy",
						description: "Deploy the service",
						aliases: ["ship-it", "deploy-alias"],
						runner,
						path: otherScriptFilename, // mutated path only
						danger: true,
					},
				],
			});
			await harness.session.reload();

			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("run_toolkit_script", {
							script: "safe-deploy",
							args: ["--prod"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Blocked after path mutation"),
			]);
			await harness.session.prompt("Run after path mutation");
			expect(confirmationRequests).toHaveLength(1);
			expect(confirmationRequests[0]?.class).toBe("toolkit.script");
			expect(lastToolResultText(harness)).toContain("confirmation");

			// 3. Mutate registry runner ONLY under same canonical name "safe-deploy" and fixed argv ["--prod"]
			const alternateRunner = isWin ? "bash" : "powershell";
			harness.settingsManager.setToolkitSettings({
				scripts: [
					{
						name: "safe-deploy",
						description: "Deploy the service",
						aliases: ["ship-it", "deploy-alias"],
						runner: alternateRunner, // mutated runner only (original path restored)
						path: scriptFilename,
						danger: true,
					},
				],
			});
			await harness.session.reload();

			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("run_toolkit_script", {
							script: "safe-deploy",
							args: ["--prod"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Blocked after runner mutation"),
			]);
			await harness.session.prompt("Run after runner mutation");
			expect(confirmationRequests).toHaveLength(2);
			expect(confirmationRequests[1]?.class).toBe("toolkit.script");
			expect(lastToolResultText(harness)).toContain("confirmation");

			// 4. Restore original registered path and runner
			harness.settingsManager.setToolkitSettings({
				scripts: createTestScripts(),
			});
			await harness.session.reload();

			// Fixed canonical name and argv now succeeds again without confirmation
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("run_toolkit_script", {
							script: "safe-deploy",
							args: ["--prod"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Restored run succeeded"),
			]);
			await harness.session.prompt("Run restored");
			expect(confirmationRequests).toHaveLength(2); // Did not increase
			expect(lastToolResultText(harness)).toContain("safe-output --prod");
		} finally {
			await harness.cleanup();
		}
	});

	it("proves alias resolves exact canonical identity across grant and execution", async () => {
		const harness = await createHarness({
			settings: {
				toolkit: {
					scripts: createTestScripts(),
				},
			},
		});
		writeHarmlessScripts(harness.tempDir);

		const confirmationRequests: EdgeConfirmationRequest[] = [];
		harness.session.setEdgeConfirmation(async (req) => {
			confirmationRequests.push(req);
			return "deny";
		});

		try {
			// Grant using alias "ship-it"
			const ownerQuote = "I grant permission to ship-it with --prod";
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("goal", {
							action: "grant_edge",
							edgeClass: "toolkit.script",
							toolkitScript: "ship-it",
							toolkitArgs: ["--prod"],
							quote: ownerQuote,
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Alias grant recorded"),
			]);
			await harness.session.prompt(ownerQuote);

			const grantText = lastToolResultText(harness);
			expect(grantText).toContain("edge granted: toolkit.script [ship-it]");
			const grants = harness.session.getEdgeGrants();
			expect(grants).toHaveLength(1);
			const grantedScopeKey = grants[0]?.scopeKey;
			expect(grantedScopeKey).toBeDefined();

			// Execute using canonical name "safe-deploy" -> authorized via exact canonical scopeKey
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("run_toolkit_script", {
							script: "safe-deploy",
							args: ["--prod"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Canonical name executed"),
			]);
			await harness.session.prompt("Run using canonical name");
			expect(confirmationRequests).toHaveLength(0);
			expect(lastToolResultText(harness)).toContain("safe-output --prod");

			// Execute using alias "ship-it" -> authorized via exact canonical scopeKey
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("run_toolkit_script", {
							script: "ship-it",
							args: ["--prod"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Alias executed"),
			]);
			await harness.session.prompt("Run using alias");
			expect(confirmationRequests).toHaveLength(0);
			expect(lastToolResultText(harness)).toContain("safe-output --prod");

			// Execute using second alias "deploy-alias" -> also authorized
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("run_toolkit_script", {
							script: "deploy-alias",
							args: ["--prod"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Second alias executed"),
			]);
			await harness.session.prompt("Run using second alias");
			expect(confirmationRequests).toHaveLength(0);
			expect(lastToolResultText(harness)).toContain("safe-output --prod");
		} finally {
			await harness.cleanup();
		}
	});

	it("proves revocation and compaction/reload preserve correct scope", async () => {
		const harness = await createHarness({
			settings: {
				toolkit: {
					scripts: createTestScripts(),
				},
			},
		});
		writeHarmlessScripts(harness.tempDir);

		const confirmationRequests: EdgeConfirmationRequest[] = [];
		harness.session.setEdgeConfirmation(async (req) => {
			confirmationRequests.push(req);
			return "deny";
		});

		try {
			// Grant narrow scope
			const ownerQuote = "Run safe-deploy --prod for release";
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("goal", {
							action: "grant_edge",
							edgeClass: "toolkit.script",
							toolkitScript: "safe-deploy",
							toolkitArgs: ["--prod"],
							quote: ownerQuote,
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Granted"),
			]);
			await harness.session.prompt(ownerQuote);

			const initialGrants = harness.session.getEdgeGrants();
			expect(initialGrants).toHaveLength(1);
			const expectedScopeKey = initialGrants[0]?.scopeKey;
			expect(expectedScopeKey).toBeDefined();

			// 1. Compaction preserves narrow grant
			harness.setResponses([fauxAssistantMessage("Compaction summary")]);
			await harness.session.compact();

			const postCompactGrants = harness.session.getEdgeGrants();
			expect(postCompactGrants).toEqual([
				expect.objectContaining({
					class: "toolkit.script",
					source: "instructions",
					scopeKey: expectedScopeKey,
				}),
			]);

			// 2. Reload preserves narrow grant
			await harness.session.reload();

			const postReloadGrants = harness.session.getEdgeGrants();
			expect(postReloadGrants).toEqual([
				expect.objectContaining({
					class: "toolkit.script",
					source: "instructions",
					scopeKey: expectedScopeKey,
				}),
			]);

			// Re-verify reloaded session executes narrow script without confirmation
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("run_toolkit_script", {
							script: "safe-deploy",
							args: ["--prod"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Executed after reload"),
			]);
			await harness.session.prompt("Execute post-reload");
			expect(confirmationRequests).toHaveLength(0);
			expect(lastToolResultText(harness)).toContain("safe-output --prod");

			// 3. Revocation removes grant
			expect(harness.session.revokeEdge("toolkit.script")).toBe(true);
			expect(harness.session.getEdgeGrants()).toEqual([]);

			// Execution after revocation requires confirmation (negative control)
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("run_toolkit_script", {
							script: "safe-deploy",
							args: ["--prod"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Blocked after revocation"),
			]);
			await harness.session.prompt("Try execute after revocation");
			expect(confirmationRequests).toHaveLength(1);
			expect(lastToolResultText(harness)).toContain("confirmation");
		} finally {
			await harness.cleanup();
		}
	});
});

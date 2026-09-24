import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BashExecutionMessage } from "@caupulican/pi-agent-core/messages";
import { fauxAssistantMessage } from "@caupulican/pi-ai";
import type { FauxRequestEvent } from "@caupulican/pi-ai/faux";
import { describe, expect, it } from "vitest";
import { classifyExecutorTurn } from "../src/core/model-router/executor-route.ts";
import type { ToolkitScript } from "../src/core/toolkit/script-registry.ts";
import { createHarness } from "./suite/harness.ts";

const SCRIPTS: ToolkitScript[] = [
	{ name: "status-report", description: "Print the service status report", runner: "bash", path: "s.sh" },
	{
		name: "restore-db",
		description: "Restore a database environment from backup",
		runner: "bash",
		path: "r.sh",
		danger: true,
	},
	{ name: "update-db", description: "Apply pending migrations to the database schema", runner: "bash", path: "u.sh" },
];

describe("classifyExecutorTurn", () => {
	it("routes exact/direct Level-0 hits on command-shaped prompts", () => {
		expect(classifyExecutorTurn("status-report", SCRIPTS)).toMatchObject({
			execute: true,
			scriptName: "status-report",
		});
	});

	it("never routes ambiguity — that stays with the big model and the reflex brain", () => {
		expect(classifyExecutorTurn("do something about the db please", SCRIPTS).execute).toBe(false);
	});

	it("never runs a scored reading of the request, only the script's name or a taught alias", () => {
		expect(classifyExecutorTurn("is the service status report fine?", SCRIPTS)).toMatchObject({
			execute: false,
			reason: "scored_match",
		});
	});

	it("never routes non-command-shaped prompts even when they mention a script", () => {
		const essay = `please carefully review the following plan and then maybe run status-report if it all looks reasonable to you overall today, thanks a lot friend`;
		expect(classifyExecutorTurn(essay, SCRIPTS)).toMatchObject({ execute: false, reason: "not_command_shaped" });
		expect(classifyExecutorTurn("line one\nstatus-report", SCRIPTS).execute).toBe(false);
	});

	it("no scripts registered -> never routes", () => {
		expect(classifyExecutorTurn("status-report", [])).toMatchObject({ execute: false, reason: "no_toolkit_scripts" });
	});
});

describe("toolkit hits run by the harness", () => {
	const setup = async (danger: boolean) => {
		const requests: FauxRequestEvent[] = [];
		const harness = await createHarness({ fauxProvider: { onRequest: (event) => requests.push(event) } });
		const marker = join(harness.tempDir, "ran.txt");
		const script = join(harness.tempDir, "status.sh");
		writeFileSync(script, `#!/usr/bin/env bash\necho ran > "${marker}"\necho "status report: all green"\n`);
		chmodSync(script, 0o755);
		harness.settingsManager.applyOverrides({
			toolkit: {
				scripts: [
					{
						name: "status-report",
						description: "Print the service status report",
						aliases: ["run the status report"],
						runner: "bash",
						path: script,
						...(danger ? { danger: true } : {}),
					},
				],
			},
		});
		return { harness, requests, marker };
	};

	it("runs an exact hit with no provider request and no model swap, recorded for the talker", async () => {
		const { harness, requests, marker } = await setup(false);
		try {
			const model = harness.session.model?.id;
			await harness.session.prompt("run the status report");
			expect(requests).toHaveLength(0);
			expect(existsSync(marker)).toBe(true);
			expect(harness.session.model?.id).toBe(model);
			const record = harness.session.messages.at(-1) as BashExecutionMessage;
			expect(record).toMatchObject({ role: "bashExecution", command: "run_toolkit_script status-report" });
			expect(record.output).toContain("status report: all green");
		} finally {
			harness.cleanup();
		}
	});

	it("does not run a dangerous script without the host's authorization", async () => {
		const { harness, requests, marker } = await setup(true);
		try {
			await harness.session.prompt("run the status report");
			expect(requests).toHaveLength(0);
			expect(existsSync(marker)).toBe(false);
			expect((harness.session.messages.at(-1) as BashExecutionMessage).output).toMatch(/confirmation_required/);
		} finally {
			harness.cleanup();
		}
	});

	it("sends a message that only reads as the script to the talker", async () => {
		const { harness, requests, marker } = await setup(false);
		try {
			harness.setResponses([fauxAssistantMessage("It printed that all is green.")]);
			await harness.session.prompt("is the status report green?");
			expect(requests).toHaveLength(1);
			expect(existsSync(marker)).toBe(false);
		} finally {
			harness.cleanup();
		}
	});
});

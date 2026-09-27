import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { tempDir } from "../temp-dir.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession event listeners", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("uses a stable listener generation when a listener unsubscribes and adds another listener", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		let healthyStarts = 0;
		let lateStarts = 0;
		let unsubscribeFirst = (): void => undefined;
		unsubscribeFirst = harness.session.subscribe((event) => {
			if (event.type !== "agent_start") return;
			harness.session.subscribe((lateEvent) => {
				if (lateEvent.type === "agent_start") lateStarts++;
			});
			unsubscribeFirst();
		});
		harness.session.subscribe((event) => {
			if (event.type === "agent_start") healthyStarts++;
		});

		await harness.session.prompt("hello");

		expect({ healthyStarts, lateStarts }).toEqual({ healthyStarts: 1, lateStarts: 0 });
	});

	it("uses a stable extension-listener generation during a live extension load", async () => {
		const projectDir = tempDir("pi-session-event-listeners-");
		const extensionPath = join(projectDir, "listener-generation-extension.ts");
		writeFileSync(extensionPath, "export default () => {};\n");
		const harness = await createHarness({
			agentDir: projectDir,
			cwd: projectDir,
			resourceLoader: new DefaultResourceLoader({ cwd: projectDir, agentDir: projectDir, noExtensions: true }),
		});
		harnesses.push(harness);

		let healthyNotifications = 0;
		let lateNotifications = 0;
		let unsubscribeFirst = (): void => undefined;
		unsubscribeFirst = harness.session.onExtensionsChanged(() => {
			harness.session.onExtensionsChanged(() => {
				lateNotifications++;
			});
			unsubscribeFirst();
		});
		harness.session.onExtensionsChanged(() => {
			healthyNotifications++;
		});

		await harness.session.loadExtensionLive(extensionPath);

		expect({ healthyNotifications, lateNotifications }).toEqual({
			healthyNotifications: 1,
			lateNotifications: 0,
		});
	});
});

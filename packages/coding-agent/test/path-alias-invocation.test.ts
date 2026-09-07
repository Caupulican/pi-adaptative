import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { expect, it } from "vitest";
import { createHarness, getMessageText } from "./suite/harness.ts";

it("reads a provider-visible alias through the session's admitted native file executor", async () => {
	const harness = await createHarness({
		initialActiveToolNames: ["read"],
		settings: { modelCapability: { mode: "off" } },
	});
	const path = "packages/example/source.ts";
	mkdirSync(join(harness.tempDir, "packages/example"), { recursive: true });
	writeFileSync(join(harness.tempDir, path), `export const reference = "${path}";\n`);
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("read", { path }, { id: "literal" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("read", { path: "p/source.ts" }, { id: "alias" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Read complete"),
	]);
	await harness.session.prompt("Read the source and follow its reference.", { autoContinueGoal: false });
	expect(harness.session.peekPathAliasTable().entries).toContainEqual({ id: "p/source.ts", path });
	const results = harness.session.messages.filter((message) => message.role === "toolResult");
	expect(results).toHaveLength(2);
	expect(results.map((result) => ({ error: result.isError, text: getMessageText(result) }))).toEqual([
		{ error: false, text: `export const reference = "${path}";` },
		{ error: false, text: `export const reference = "${path}";` },
	]);
});

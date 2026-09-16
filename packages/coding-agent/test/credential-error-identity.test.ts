import { AgentToolExecutionError } from "@caupulican/pi-agent-core/types";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { wrapToolWithCredentialExposureGuard } from "../src/core/secrets/credential-exposure-guard.ts";

describe("credential guard error identity", () => {
	it("masks unknown named credentials in consumer errors without losing failure identity", async () => {
		const tool = wrapToolWithCredentialExposureGuard(
			{
				name: "trello",
				label: "trello",
				description: "Credential consumer error fixture",
				parameters: Type.Object({}),
				async execute() {
					throw new AgentToolExecutionError(
						'Trello request failed\n{"TRELLO_TOKEN":"opaque-private-value"}',
						"request_failed",
						"trello-request-failed",
						"tool_failure",
					);
				},
			},
			process.cwd(),
			undefined,
			"mock",
		);
		await expect(tool.execute("consumer-error", {})).rejects.toMatchObject({
			message: 'Trello request failed\n{"TRELLO_TOKEN":"<mocked:TRELLO_TOKEN>"}',
			failureCode: "request_failed",
			outputSignature: "trello-request-failed",
			errorKind: "tool_failure",
		});
	});

	it.each(["operation_outcome", "tool_failure"] as const)(
		"preserves %s from another runtime copy while redacting diagnostics",
		async (errorKind) => {
			// Duplicate package loaders preserve these fields but have a different class prototype.
			const foreignError = Object.assign(new Error("failed with synthetic-private-marker"), {
				name: "AgentToolExecutionError",
				failureCode: "exit_7",
				outputSignature: "complete-output-signature",
				errorKind,
			});
			expect(foreignError).not.toBeInstanceOf(AgentToolExecutionError);
			const tool = wrapToolWithCredentialExposureGuard(
				{
					name: "python",
					label: "python",
					description: "Isolated error fixture",
					parameters: Type.Object({}),
					async execute() {
						throw foreignError;
					},
				},
				process.cwd(),
				{ redactSensitiveText: (text) => text.replaceAll("synthetic-private-marker", "[redacted]") },
			);
			await expect(tool.execute("foreign-error", {})).rejects.toMatchObject({
				message: "failed with [redacted]",
				failureCode: "exit_7",
				outputSignature: "complete-output-signature",
				errorKind,
			});
			Object.assign(foreignError, { errorKind: "invalid" });
			await expect(tool.execute("unclassified-error", {})).rejects.not.toBeInstanceOf(AgentToolExecutionError);
		},
	);
});

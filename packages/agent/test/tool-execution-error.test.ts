import { describe, expect, it } from "vitest";
import { AgentToolExecutionError, describeThrownToolError, readAgentToolExecutionError } from "../src/types.ts";

describe("readAgentToolExecutionError", () => {
	it("snapshots a real AgentToolExecutionError instead of returning the same object", () => {
		const error = new AgentToolExecutionError("FAILED (errors=2)", "exit_1", "sig", "operation_outcome");
		const reconstructed = readAgentToolExecutionError(error);
		expect(reconstructed).not.toBe(error);
		expect(reconstructed).toBeInstanceOf(AgentToolExecutionError);
		expect(reconstructed?.message).toBe("FAILED (errors=2)");
		expect(reconstructed?.errorKind).toBe("operation_outcome");
	});

	it("reconstructs a duck-typed copy that lost class identity", () => {
		const reconstructed = readAgentToolExecutionError({
			name: "AgentToolExecutionError",
			message: "FAILED (errors=2)",
			failureCode: "exit_1",
			outputSignature: "sig",
			errorKind: "operation_outcome",
		});
		expect(reconstructed).toBeInstanceOf(AgentToolExecutionError);
		expect(reconstructed?.errorKind).toBe("operation_outcome");
		expect(reconstructed?.failureCode).toBe("exit_1");
		expect(reconstructed?.message).toBe("FAILED (errors=2)");
	});

	it("returns undefined when field accessors throw", () => {
		const hostile = {
			get name(): string {
				throw new Error("hostile name");
			},
			message: "FAILED (errors=2)",
			failureCode: "exit_1",
			outputSignature: "sig",
			errorKind: "operation_outcome",
		};
		expect(readAgentToolExecutionError(hostile)).toBeUndefined();
	});

	it("returns undefined when a same-prototype object has a throwing message getter", () => {
		const error = new AgentToolExecutionError("FAILED (errors=2)", "exit_1", "sig", "operation_outcome");
		Object.defineProperty(error, "message", {
			get() {
				throw new Error("hostile message");
			},
		});
		expect(readAgentToolExecutionError(error)).toBeUndefined();
	});

	it("does not treat empty outputSignature as invalid", () => {
		const reconstructed = readAgentToolExecutionError({
			name: "AgentToolExecutionError",
			message: "FAILED (errors=2)",
			failureCode: "exit_1",
			outputSignature: "",
			errorKind: "operation_outcome",
		});
		expect(reconstructed?.outputSignature).toBe("");
		expect(reconstructed?.errorKind).toBe("operation_outcome");
	});

	it("rejects empty message and unsupported errorKind", () => {
		expect(
			readAgentToolExecutionError({
				name: "AgentToolExecutionError",
				message: "",
				failureCode: "exit_1",
				outputSignature: "sig",
				errorKind: "operation_outcome",
			}),
		).toBeUndefined();
		expect(
			readAgentToolExecutionError({
				name: "AgentToolExecutionError",
				message: "FAILED",
				failureCode: "exit_1",
				outputSignature: "sig",
				errorKind: "cancelled",
			}),
		).toBeUndefined();
	});

	it("snapshots a revoked proxy as an unclassified failure instead of throwing", () => {
		const { proxy, revoke } = Proxy.revocable(
			{
				name: "AgentToolExecutionError",
				message: "FAILED (errors=2)",
				failureCode: "exit_1",
				outputSignature: "sig",
				errorKind: "operation_outcome",
			},
			{},
		);
		revoke();
		expect(readAgentToolExecutionError(proxy)).toBeUndefined();
		const described = describeThrownToolError(proxy);
		expect(described.structured).toBeUndefined();
		expect(described.message).toBe("Tool execution failed.");
	});

	it("rejects objects that omit message, name, or errorKind", () => {
		expect(
			readAgentToolExecutionError({
				name: "AgentToolExecutionError",
				failureCode: "exit_1",
				outputSignature: "sig",
				errorKind: "operation_outcome",
			}),
		).toBeUndefined();
		expect(
			readAgentToolExecutionError({
				name: "Error",
				message: "FAILED (errors=2)",
				failureCode: "exit_1",
				outputSignature: "sig",
				errorKind: "operation_outcome",
			}),
		).toBeUndefined();
		expect(
			readAgentToolExecutionError({
				name: "AgentToolExecutionError",
				message: "FAILED (errors=2)",
				failureCode: "exit_1",
				outputSignature: "sig",
			}),
		).toBeUndefined();
	});
});

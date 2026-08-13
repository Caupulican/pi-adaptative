import { describe, expect, it } from "vitest";
import { assessToolFailure } from "../src/tool-failure-memory.ts";

describe("process-exit failure diagnostics", () => {
	it("retains an explicit compiler diagnostic while keeping the exit status authoritative", () => {
		const assessment = assessToolFailure(
			[
				"Compiling example v0.1.0",
				"error[E0425]: cannot find value `missing` in this scope",
				"  --> src/main.rs:4:5",
				"error: could not compile `example` due to 1 previous error",
				"Command exited with code 101",
			].join("\n"),
			"failed",
			"Error",
		);

		expect(assessment).toMatchObject({
			failureCode: "exit_101",
			phase: "execution",
			diagnostic: "error[E0425]: cannot find value `missing` in this scope",
		});
		expect(assessment.guidance).toContain("Read diagnostic");
	});

	it("does not turn identifier-like stdout prose into a diagnostic", () => {
		const assessment = assessToolFailure(
			[
				"let label = generated::EXPORTED_ACTION_LABEL.0;",
				"// A stopped runtime cannot process background work.",
				"Command exited with code 2",
			].join("\n"),
			"failed",
			"Error",
		);

		expect(assessment.failureCode).toBe("exit_2");
		expect(assessment.diagnostic).toBeUndefined();
	});

	it("keeps the tool-owned trailer authoritative over an unrelated 'exit N' phrase in captured stdout", () => {
		const assessment = assessToolFailure(
			["Stopping container gracefully.", "container will exit 0 on SIGTERM", "Command exited with code 1"].join(
				"\n",
			),
			"failed",
			"Error",
		);

		expect(assessment.failureCode).toBe("exit_1");
	});
});

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

	it("keeps the exit classification and routes the appended cwd line through evidence, never diagnostic", () => {
		const assessment = assessToolFailure(
			["probe output tail", "", "Command exited with code 3", "cwd: /home/user/project/packages/agent"].join("\n"),
			"failed",
			"Error",
		);

		expect(assessment.failureCode).toBe("exit_3");
		expect(assessment.diagnostic).toBeUndefined();
		expect(assessment.evidence).toBe(["probe output tail", "cwd: /home/user/project/packages/agent"].join("\n"));
	});

	it("never lets a cwd path that contains error-like words displace a real diagnostic", () => {
		const assessment = assessToolFailure(
			[
				"ls: cannot access '/repo/missing': No such file or directory",
				"",
				"Command exited with code 2",
				"cwd: /home/user/error-cases",
			].join("\n"),
			"failed",
			"Error",
		);

		expect(assessment.failureCode).toBe("file_not_found");
		expect(assessment.diagnostic).toBe("ls: cannot access '/repo/missing': No such file or directory");
		expect(assessment.evidence).toBe(
			["ls: cannot access '/repo/missing': No such file or directory", "cwd: /home/user/error-cases"].join("\n"),
		);
	});

	it("keeps the cwd line out of the weak stderr diagnostic fallback", () => {
		const assessment = assessToolFailure(
			[
				"stdout:",
				"doing the thing",
				"stderr:",
				"mv: cannot stat 'src/a.txt': No such file or directory",
				"Command exited with code 1",
				"cwd: /work/error-handling",
			].join("\n"),
			"failed",
			"Error",
		);

		expect(assessment.failureCode).toBe("file_not_found");
		expect(assessment.diagnostic).toBe("mv: cannot stat 'src/a.txt': No such file or directory");
		expect(assessment.diagnostic).not.toContain("cwd:");
	});
});

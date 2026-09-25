import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	judgeOperation,
	type OperationEffectEngine,
	triageOperation,
} from "../../src/core/system-one/operation-classifier.ts";
import { OperationGate } from "../../src/core/system-one/operation-gate.ts";

const scope = join(tmpdir(), "pi-operation-gate-task");

function triage(toolName: string, args: unknown) {
	return triageOperation({ toolName, args, cwd: scope, scopeCwd: scope, tempDir: join(tmpdir(), "pi-temp-root") });
}

/** A System One that answers each question with a fixed probability. */
function engine(answers: Record<string, number>): OperationEffectEngine & { calls: number } {
	const fake = {
		calls: 0,
		async evaluate() {
			fake.calls++;
			return { answers: Object.fromEntries(Object.entries(answers).map(([id, noul]) => [id, { noul }])) };
		},
	};
	return fake;
}

const LOCAL = {
	leaves_machine: 0.02,
	cannot_be_undone: 0.03,
	touches_outside_task: 0.02,
	acquires_external_code: 0.02,
	request_authorizes: 0.5,
};
const OUTWARD = {
	leaves_machine: 0.98,
	cannot_be_undone: 0.4,
	touches_outside_task: 0.1,
	acquires_external_code: 0.05,
};

describe("operation triage", () => {
	it("leaves tools without effects, writes inside the task, and the edge's own operations alone", () => {
		expect(triage("read", { path: "/etc/hosts" }).kind).toBe("decided");
		expect(triage("grep", { pattern: "x" }).kind).toBe("decided");
		expect(triage("task_steps", { action: "set", steps: [] }).kind).toBe("decided");
		expect(triage("write", { path: "src/a.ts", content: "" }).kind).toBe("decided");
		expect(triage("write", { path: join(tmpdir(), "pi-temp-root", "x"), content: "" }).kind).toBe("decided");
		expect(triage("bash", { command: "rm -rf /" }).kind).toBe("decided");
	});

	it("sends every shell or code call, in any language, and every write outside the task to System One", () => {
		for (const command of ["npm test", "cat script.txt | bash", "curl -X POST https://api.example.test -d @x"]) {
			expect(triage("bash", { command }), command).toMatchObject({
				kind: "judged",
				operationKind: "shell",
				operation: command,
			});
		}
		expect(
			triage("python", {
				code: 'import urllib.request\nurllib.request.urlopen("https://api.example.test", data=b"x")',
			}),
		).toMatchObject({ kind: "judged", operationKind: "code" });
		expect(triage("write", { path: "/srv/shared/team.yaml", content: "" })).toMatchObject({
			kind: "judged",
			operationKind: "write_outside_task",
			operation: `write ${resolve(scope, "/srv/shared/team.yaml")}`,
		});
	});
});

describe("operation judgment", () => {
	const undecidable = triage("bash", { command: "curl -X POST https://api.example.test -d @x" });
	if (undecidable.kind !== "judged") throw new Error("fixture must be judged");
	const judge = (answers: Record<string, number>, actor: "root" | "worker" = "root") =>
		judgeOperation(engine(answers), {
			triage: undecidable,
			toolName: "bash",
			scopeCwd: scope,
			request: "Post the build report to the team API.",
			actor,
		});

	it("runs what System One finds local and reversible", async () => {
		expect(await judge(LOCAL)).toMatchObject({ action: "proceed", notable: false });
		// Live System One reads ordinary commands at up to 0.22 on an effect: they run silently.
		expect(
			await judge({
				leaves_machine: 0.17,
				cannot_be_undone: 0.12,
				touches_outside_task: 0.14,
				acquires_external_code: 0.22,
				request_authorizes: 0.48,
			}),
		).toMatchObject({ action: "proceed", notable: false });
	});

	it("runs an outward effect the request asks for, and refuses one it clearly does not", async () => {
		expect(await judge({ ...OUTWARD, request_authorizes: 0.97 })).toMatchObject({
			action: "proceed",
			finding: "leaves the machine; the owner's request asks for it",
		});
		expect(await judge({ ...OUTWARD, request_authorizes: 0.06 })).toMatchObject({
			action: "refuse",
			finding: "leaves the machine; the owner's request does not ask for it",
		});
	});

	it("sends an unsettled effect, or a System One that cannot answer, to the operator", async () => {
		expect(await judge({ ...OUTWARD, request_authorizes: 0.5 })).toMatchObject({ action: "confirm" });
		expect(await judge({ ...OUTWARD, request_authorizes: 0.5 }, "worker")).toMatchObject({ action: "refuse" });
		expect(
			await judge({
				leaves_machine: 0.6,
				cannot_be_undone: 0.6,
				touches_outside_task: 0.6,
				acquires_external_code: 0.6,
				request_authorizes: 0.5,
			}),
		).toMatchObject({ action: "confirm", finding: expect.stringContaining("possibly leaves the machine") });
		const failing: OperationEffectEngine = {
			evaluate: async () => {
				throw new Error("engine down");
			},
		};
		expect(
			await judgeOperation(failing, {
				triage: undecidable,
				toolName: "bash",
				scopeCwd: scope,
				request: "",
				actor: "root",
			}),
		).toMatchObject({
			action: "confirm",
			finding: expect.stringContaining("System One could not judge it (engine down)"),
		});
	});

	it("treats a missing answer as unsettled, never as established or absent", async () => {
		expect(await judge({ leaves_machine: 0.02, cannot_be_undone: 0.03, touches_outside_task: 0.02 })).toMatchObject({
			action: "confirm",
			finding: "possibly acquires external code; the owner's request does not settle it",
		});
	});

	it("counts a System One that runs out of time as unavailable", async () => {
		const slow: OperationEffectEngine = {
			evaluate: (_program, _state, options) =>
				new Promise((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () => reject(new Error("timed out")));
				}),
		};
		const verdict = await judgeOperation(slow, {
			triage: undecidable,
			toolName: "bash",
			scopeCwd: scope,
			request: "",
			actor: "root",
			timeoutMs: 20,
		});
		expect(verdict).toMatchObject({ action: "confirm", finding: expect.stringContaining("timed out") });
	});
});

describe("operation gate", () => {
	const command = { command: "curl -X POST https://api.example.test -d @x" };

	function gate(options: { answers: Record<string, number>; granted?: boolean; asks?: boolean; turn?: () => string }) {
		const fake = engine(options.answers);
		const notices: string[] = [];
		const askOperator = vi.fn(async () => ({ authorized: false, reason: "operator denied" }));
		const operationGate = new OperationGate({
			getEngine: () => fake,
			getRequest: () => "Summarise the build.",
			getScopeCwd: () => scope,
			getTurnKey: options.turn ?? (() => "turn-1"),
			isGranted: () => options.granted ?? false,
			...(options.asks === false ? {} : { askOperator }),
			notify: (message) => notices.push(message),
		});
		return { operationGate, fake, notices, askOperator };
	}

	it("leaves a session without System One to the deterministic gates", async () => {
		const operationGate = new OperationGate({
			getEngine: () => undefined,
			getRequest: () => "",
			getScopeCwd: () => scope,
			getTurnKey: () => "t",
			isGranted: () => false,
			notify: () => {},
		});
		expect(await operationGate.check("bash", command, scope, "root")).toBeUndefined();
	});

	it("lets worker shell use the deterministic extreme-destruction edge without semantic review", async () => {
		const { operationGate, fake, askOperator } = gate({ answers: { ...OUTWARD, request_authorizes: 0.5 } });
		expect(
			await operationGate.check("bash", { command: "git log --simplify-by-decoration" }, scope, "worker"),
		).toBeUndefined();
		expect(fake.calls).toBe(0);
		expect(askOperator).not.toHaveBeenCalled();
	});

	it("runs what System One finds local and reversible without a word, and never asks about a read", async () => {
		const { operationGate, fake, notices } = gate({ answers: LOCAL });
		expect(await operationGate.check("bash", { command: "npm test" }, scope, "root")).toBeUndefined();
		expect(notices).toEqual([]);
		expect(await operationGate.check("read", { path: "a.ts" }, scope, "root")).toBeUndefined();
		expect(fake.calls).toBe(1);
	});

	it("asks the operator for the root and judges a repeat only once per turn", async () => {
		const unsettled = { ...OUTWARD, request_authorizes: 0.5 };
		const root = gate({ answers: unsettled });
		expect(await root.operationGate.check("bash", command, scope, "root")).toMatchObject({
			block: true,
			reason: "operator denied",
		});
		expect(root.askOperator).toHaveBeenCalledWith(
			expect.objectContaining({ class: "operation.irreversible", operation: command.command }),
			undefined,
		);
		await root.operationGate.check("bash", command, scope, "root");
		expect(root.fake.calls).toBe(1);
	});

	it("runs under the operator's standing grant and says what System One found", async () => {
		const { operationGate, notices, askOperator } = gate({
			answers: { ...OUTWARD, request_authorizes: 0.02 },
			granted: true,
		});
		expect(await operationGate.check("bash", command, scope, "root")).toBeUndefined();
		expect(askOperator).not.toHaveBeenCalled();
		expect(notices[0]).toContain("it runs under your operation.irreversible grant");
	});

	it("judges again in a new turn", async () => {
		let turn = "turn-1";
		const { operationGate, fake } = gate({ answers: LOCAL, turn: () => turn });
		await operationGate.check("bash", command, scope, "root");
		turn = "turn-2";
		await operationGate.check("bash", command, scope, "root");
		expect(fake.calls).toBe(2);
	});
});

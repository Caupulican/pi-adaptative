import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OperationEffectEngine } from "../../src/core/system-one/operation-classifier.ts";
import type { OperationEffectDurableStore } from "../../src/core/system-one/operation-effect-cache.ts";
import { OperationGate, type OperationGateDecisionRecord } from "../../src/core/system-one/operation-gate.ts";

const scope = join(tmpdir(), "pi-operation-cache-task");
const NO_EFFECT = {
	leaves_machine: 0.02,
	cannot_be_undone: 0.03,
	touches_outside_task: 0.02,
	acquires_external_code: 0.02,
};
const OUTWARD = {
	leaves_machine: 0.98,
	cannot_be_undone: 0.4,
	touches_outside_task: 0.1,
	acquires_external_code: 0.05,
};

interface Call {
	ids: string[];
}

/** Answers by question id; a batched request's `c<n>_<id>` ids answer from `perCall[n]`. */
function engine(options: {
	model?: string | undefined;
	answers: Record<string, number>;
	perCall?: Record<string, number>[];
	fail?: boolean;
	/** The model id the answer reports; the engine's own `model` when absent. */
	returnedModel?: () => string | undefined;
}): OperationEffectEngine & { calls: Call[] } {
	const fake: OperationEffectEngine & { calls: Call[] } = {
		calls: [],
		...(options.model === undefined && "model" in options ? {} : { model: options.model ?? "jev-1.13.0" }),
		async evaluate(program) {
			const ids = (program.decisions as { id: string }[]).map((decision) => decision.id);
			fake.calls.push({ ids });
			if (options.fail) throw new Error("engine down");
			const answers: Record<string, unknown> = {};
			for (const id of ids) {
				const batched = /^c(\d+)_(.+)$/.exec(id);
				const table = batched ? (options.perCall?.[Number(batched[1])] ?? options.answers) : options.answers;
				const value = table[batched ? batched[2]! : id];
				if (value !== undefined) answers[id] = { noul: value };
			}
			const model = options.returnedModel?.();
			return { answers, ...(model ? { model } : {}) };
		},
	};
	return fake;
}

function gate(
	fake: OperationEffectEngine,
	extra: {
		turn?: () => string;
		store?: OperationEffectDurableStore;
		decisions?: OperationGateDecisionRecord[];
		notices?: string[];
		request?: string;
	} = {},
) {
	return new OperationGate({
		getEngine: () => fake,
		getRequest: () => extra.request ?? "Summarise the build.",
		getScopeCwd: () => scope,
		getTurnKey: extra.turn ?? (() => "turn-1"),
		isGranted: () => false,
		askOperator: async () => ({ authorized: false, reason: "operator denied" }),
		notify: (message) => extra.notices?.push(message),
		...(extra.store ? { getEffectStore: () => extra.store } : {}),
		...(extra.decisions ? { recordDecision: (decision) => extra.decisions?.push(decision) } : {}),
	});
}

const npmTest = { command: "npm test" };
const curl = { command: "curl -X POST https://api.example.test -d @x" };

describe("operation effect cache", () => {
	it("asks System One once for a command with no effect and never again, in any later turn", async () => {
		let turn = "turn-1";
		const fake = engine({ answers: { ...NO_EFFECT, request_authorizes: 0.5 } });
		const decisions: OperationGateDecisionRecord[] = [];
		const operationGate = gate(fake, { turn: () => turn, decisions });
		expect(await operationGate.check("bash", npmTest, scope, "root")).toBeUndefined();
		turn = "turn-2";
		expect(await operationGate.check("bash", npmTest, scope, "root")).toBeUndefined();
		turn = "turn-3";
		expect(await operationGate.check("bash", npmTest, scope, "worker")).toBeUndefined();
		expect(fake.calls).toHaveLength(1);
		expect(decisions.map((decision) => decision.source)).toEqual(["jev", "cache", "cache"]);
	});

	it("asks only whether the request asks for it when the remembered effects are not nil", async () => {
		let turn = "turn-1";
		const fake = engine({ answers: { ...OUTWARD, request_authorizes: 0.97 } });
		const operationGate = gate(fake, { turn: () => turn });
		expect(await operationGate.check("bash", curl, scope, "root")).toBeUndefined();
		expect(fake.calls[0]?.ids).toEqual([
			"leaves_machine",
			"cannot_be_undone",
			"touches_outside_task",
			"acquires_external_code",
			"request_authorizes",
		]);
		turn = "turn-2";
		expect(await operationGate.check("bash", curl, scope, "root")).toBeUndefined();
		expect(fake.calls[1]?.ids).toEqual(["request_authorizes"]);
		expect(fake.calls).toHaveLength(2);
	});

	it("takes the owner's request from the new turn, not from the remembered one", async () => {
		let turn = "turn-1";
		let request = "Post the build report to the team API.";
		let asks = 0.97;
		const fake: OperationEffectEngine = {
			model: "jev-1.13.0",
			async evaluate(program) {
				const ids = (program.decisions as { id: string }[]).map((decision) => decision.id);
				return {
					answers: Object.fromEntries(
						ids.map((id) => [
							id,
							{ noul: id === "request_authorizes" ? asks : (OUTWARD as Record<string, number>)[id] },
						]),
					),
				};
			},
		};
		const operationGate = new OperationGate({
			getEngine: () => fake,
			getRequest: () => request,
			getScopeCwd: () => scope,
			getTurnKey: () => turn,
			isGranted: () => false,
			notify: () => {},
		});
		expect(await operationGate.check("bash", curl, scope, "root")).toBeUndefined();
		turn = "turn-2";
		request = "Summarise the build.";
		asks = 0.05;
		expect(await operationGate.check("bash", curl, scope, "root")).toMatchObject({
			block: true,
			reason: expect.stringContaining("System One refused"),
		});
	});

	it("keeps a remembered effect from running past the operator when the request question cannot be answered", async () => {
		let turn = "turn-1";
		let down = false;
		const fake: OperationEffectEngine = {
			model: "jev-1.13.0",
			async evaluate(program) {
				if (down) throw new Error("engine down");
				const ids = (program.decisions as { id: string }[]).map((decision) => decision.id);
				return {
					answers: Object.fromEntries(
						ids.map((id) => [
							id,
							{ noul: id === "request_authorizes" ? 0.97 : (OUTWARD as Record<string, number>)[id] },
						]),
					),
				};
			},
		};
		const operationGate = new OperationGate({
			getEngine: () => fake,
			getRequest: () => "Post it.",
			getScopeCwd: () => scope,
			getTurnKey: () => turn,
			isGranted: () => false,
			askOperator: async () => ({ authorized: false, reason: "operator decides" }),
			notify: () => {},
		});
		expect(await operationGate.check("bash", curl, scope, "root")).toBeUndefined();
		turn = "turn-2";
		down = true;
		expect(await operationGate.check("bash", curl, scope, "root")).toMatchObject({
			block: true,
			reason: "operator decides",
		});
	});

	it("never serves a reading across System One models", async () => {
		const first = engine({ model: "jev-1.13.0", answers: { ...NO_EFFECT, request_authorizes: 0.5 } });
		const second = engine({ model: "jev-1.14.0", answers: { ...NO_EFFECT, request_authorizes: 0.5 } });
		const store = memoryStore();
		await gate(first, { store }).check("bash", npmTest, scope, "root");
		await gate(second, { store }).check("bash", npmTest, scope, "root");
		expect(first.calls).toHaveLength(1);
		expect(second.calls).toHaveLength(1);
	});

	it("keeps and reads a reading under the model that answered, so a model change never serves an older one", async () => {
		let turn = "turn-1";
		let answering = "jev-1.14.0";
		const fake = engine({
			model: "jev-1.13.0",
			answers: { ...NO_EFFECT, request_authorizes: 0.5 },
			returnedModel: () => answering,
		});
		const operationGate = gate(fake, { turn: () => turn });
		const other = { command: "npm run build" };
		await operationGate.check("bash", npmTest, scope, "root");
		turn = "turn-2";
		await operationGate.check("bash", npmTest, scope, "root");
		expect(fake.calls).toHaveLength(1);

		// A different model answers the next question: what it was asked before is no longer served.
		answering = "jev-1.15.0";
		await operationGate.check("bash", other, scope, "root");
		turn = "turn-3";
		await operationGate.check("bash", npmTest, scope, "root");
		expect(fake.calls).toHaveLength(3);
	});

	it("does not cache without a known model, nor a reading with a missing effect answer", async () => {
		let turn = "turn-1";
		const unmodeled = engine({ model: undefined, answers: { ...NO_EFFECT, request_authorizes: 0.5 } });
		const unmodeledGate = gate(unmodeled, { turn: () => turn });
		await unmodeledGate.check("bash", npmTest, scope, "root");
		turn = "turn-2";
		await unmodeledGate.check("bash", npmTest, scope, "root");
		expect(unmodeled.calls).toHaveLength(2);

		turn = "turn-1";
		const partial = engine({
			answers: { leaves_machine: 0.02, cannot_be_undone: 0.03, touches_outside_task: 0.02, request_authorizes: 0.5 },
		});
		const partialGate = gate(partial, { turn: () => turn });
		await partialGate.check("bash", npmTest, scope, "root");
		turn = "turn-2";
		await partialGate.check("bash", npmTest, scope, "root");
		expect(partial.calls).toHaveLength(2);
	});

	it("shares readings across sessions through the durable store", async () => {
		const store = memoryStore();
		const first = engine({ answers: { ...NO_EFFECT, request_authorizes: 0.5 } });
		await gate(first, { store }).check("bash", npmTest, scope, "root");
		const second = engine({ answers: { ...NO_EFFECT, request_authorizes: 0.5 } });
		expect(await gate(second, { store }).check("bash", npmTest, scope, "root")).toBeUndefined();
		expect(second.calls).toHaveLength(0);
	});

	it("reports a failing store once and still decides from System One", async () => {
		const notices: string[] = [];
		const broken: OperationEffectDurableStore = {
			read: () => {
				throw new Error("disk gone");
			},
			write: () => {
				throw new Error("disk gone");
			},
		};
		const fake = engine({ answers: { ...NO_EFFECT, request_authorizes: 0.5 } });
		const operationGate = gate(fake, { store: broken, notices });
		await operationGate.check("bash", npmTest, scope, "root");
		await operationGate.check("bash", { command: "npm run build" }, scope, "root");
		expect(fake.calls).toHaveLength(2);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("disk gone");
	});

	it("does not let a failing decision recorder change a verdict", async () => {
		const notices: string[] = [];
		const fake = engine({ answers: { ...NO_EFFECT, request_authorizes: 0.5 } });
		const operationGate = new OperationGate({
			getEngine: () => fake,
			getRequest: () => "x",
			getScopeCwd: () => scope,
			getTurnKey: () => "t",
			isGranted: () => false,
			notify: (message) => notices.push(message),
			recordDecision: () => {
				throw new Error("ledger locked");
			},
		});
		expect(await operationGate.check("bash", npmTest, scope, "root")).toBeUndefined();
		expect(notices).toEqual([expect.stringContaining("ledger locked")]);
	});
});

describe("operation prewarm", () => {
	it("judges the calls of one message in a single request and leaves their checks nothing to ask", async () => {
		const fake = engine({
			answers: {},
			perCall: [
				{ ...NO_EFFECT, request_authorizes: 0.5 },
				{ ...OUTWARD, request_authorizes: 0.06 },
			],
		});
		const operationGate = gate(fake);
		operationGate.prewarm([
			{ toolName: "bash", args: npmTest, cwd: scope },
			{ toolName: "bash", args: curl, cwd: scope },
		]);
		expect(await operationGate.check("bash", npmTest, scope, "root")).toBeUndefined();
		expect(await operationGate.check("bash", curl, scope, "root")).toMatchObject({
			block: true,
			reason: expect.stringContaining("System One refused"),
		});
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]?.ids).toHaveLength(10);
		expect(fake.calls[0]?.ids[0]).toBe("c0_leaves_machine");
	});

	it("points each batched question at its own operation", async () => {
		const seen: { instructions: string[]; state: unknown }[] = [];
		const fake: OperationEffectEngine = {
			model: "jev-1.13.0",
			async evaluate(program, state) {
				seen.push({
					instructions: (program.decisions as { instruction: string }[]).map((decision) => decision.instruction),
					state,
				});
				return { answers: {} };
			},
		};
		gate(fake).prewarm([
			{ toolName: "bash", args: npmTest, cwd: scope },
			{ toolName: "bash", args: curl, cwd: scope },
		]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const [request] = seen;
		expect(request?.instructions.some((text) => text.includes("`operations[0].command`"))).toBe(true);
		expect(request?.instructions.some((text) => text.includes("`operations[1].command`"))).toBe(true);
		expect(request?.instructions.some((text) => text.includes("`operation."))).toBe(false);
		const state = request?.state as { operations: { command: string }[] };
		expect(state.operations.map((operation) => operation.command)).toEqual([npmTest.command, curl.command]);
	});

	it("falls back to judging the call itself when the batch fails (negative control)", async () => {
		const fake = engine({ answers: {}, fail: true });
		const operationGate = gate(fake);
		operationGate.prewarm([
			{ toolName: "bash", args: npmTest, cwd: scope },
			{ toolName: "bash", args: curl, cwd: scope },
		]);
		const notices: string[] = [];
		expect(await operationGate.check("bash", npmTest, scope, "root")).toBeUndefined();
		expect(fake.calls.length).toBeGreaterThanOrEqual(2);
		expect(notices).toEqual([]);
	});

	it("skips calls already remembered, decided by code, or under the standing grant", async () => {
		const fake = engine({ answers: { ...NO_EFFECT, request_authorizes: 0.5 } });
		const operationGate = gate(fake);
		await operationGate.check("bash", npmTest, scope, "root");
		fake.calls.length = 0;
		operationGate.prewarm([
			{ toolName: "bash", args: npmTest, cwd: scope },
			{ toolName: "read", args: { path: "a.ts" }, cwd: scope },
		]);
		expect(fake.calls).toHaveLength(0);

		const granted = new OperationGate({
			getEngine: () => fake,
			getRequest: () => "x",
			getScopeCwd: () => scope,
			getTurnKey: () => "t",
			isGranted: () => true,
			notify: vi.fn(),
		});
		granted.prewarm([{ toolName: "bash", args: curl, cwd: scope }]);
		expect(fake.calls).toHaveLength(0);
	});

	it("does not throw into the tool reservation when a call's identity cannot be computed", () => {
		const operationGate = gate(engine({ answers: {} }));
		expect(() =>
			operationGate.prewarm([{ toolName: "bash", args: { command: "bash \u0000bad.sh" }, cwd: "\u0000" }]),
		).not.toThrow();
	});
});

function memoryStore(): OperationEffectDurableStore {
	const rows = new Map<string, Record<string, number | null>>();
	return {
		read: (key) => rows.get(key),
		write: (key, _model, readings) => {
			rows.set(key, readings);
		},
	};
}

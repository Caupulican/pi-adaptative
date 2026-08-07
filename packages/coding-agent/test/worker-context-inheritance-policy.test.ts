import { describe, expect, it } from "vitest";
import { resolveWorkerContextInheritanceMode } from "../src/core/delegation/worker-context-inheritance-policy.ts";

const parent = { provider: "openai", model: "gpt-5.6" };

describe("worker context inheritance egress policy", () => {
	it("defaults omitted mode to all only for the exact same provider and model", () => {
		expect(resolveWorkerContextInheritanceMode({ parent, worker: { ...parent } })).toEqual({ kind: "all" });
		expect(
			resolveWorkerContextInheritanceMode({
				parent,
				worker: { provider: "anthropic", model: parent.model },
			}),
		).toEqual({ kind: "none" });
		expect(
			resolveWorkerContextInheritanceMode({
				parent,
				worker: { provider: parent.provider, model: "gpt-5.6-mini" },
			}),
		).toEqual({ kind: "none" });
		expect(
			resolveWorkerContextInheritanceMode({
				parent,
				worker: { provider: "OpenAI", model: parent.model },
			}),
		).toEqual({ kind: "none" });
	});

	it("allows explicit inheritance only within the exact provider-model boundary", () => {
		expect(resolveWorkerContextInheritanceMode({ parent, worker: { ...parent }, mode: "3" })).toEqual({
			kind: "last_user_turns",
			count: 3,
		});
		expect(
			resolveWorkerContextInheritanceMode({
				parent,
				worker: { provider: "anthropic", model: "claude" },
				mode: "none",
			}),
		).toEqual({ kind: "none" });
		for (const mode of ["all", "2"]) {
			expect(() =>
				resolveWorkerContextInheritanceMode({
					parent,
					worker: { provider: "anthropic", model: "claude" },
					mode,
				}),
			).toThrow("provider/model boundary");
		}
	});
});

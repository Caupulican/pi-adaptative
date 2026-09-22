import { describe, expect, it } from "vitest";
import { SystemOneSteeringPlane } from "../../src/core/steering/system-one-steering-plane.ts";
import type { JevAdapter } from "../../src/core/system-one/adapter.ts";
import {
	authorityForCheckpoint,
	decideByAuthority,
	GATHER_MORE_LIMIT,
} from "../../src/core/system-one/authority-line.ts";

describe("authority line", () => {
	it("never stops reversible work on a doubt or an outage", () => {
		expect(decideByAuthority("reversible_work", "doubt", 0).action).toBe("proceed_with_doubt");
		expect(decideByAuthority("reversible_work", "unavailable", 0).action).toBe("proceed_with_doubt");
		expect(decideByAuthority("reversible_work", "ambiguous", 0).action).toBe("gather_more");
		expect(decideByAuthority("reversible_work", "ambiguous", GATHER_MORE_LIMIT).action).toBe("proceed_with_doubt");
	});

	it("never closes an objective on a doubt, and holds it on an outage", () => {
		expect(decideByAuthority("objective_transition", "doubt", 0).action).toBe("hold");
		expect(decideByAuthority("objective_transition", "unavailable", 0).action).toBe("hold");
		expect(decideByAuthority("objective_transition", "ambiguous", GATHER_MORE_LIMIT).action).toBe("owner_question");
		expect(authorityForCheckpoint("JEV-024")).toBe("objective_transition");
		expect(authorityForCheckpoint("JEV-004")).toBe("reversible_work");
	});

	it("sends an unsettled irreversible operation to the operator, and refuses it for a worker", () => {
		expect(decideByAuthority("irreversible", "unavailable", 0, "root").action).toBe("ask_operator");
		expect(decideByAuthority("irreversible", "ambiguous", 0, "worker").action).toBe("refuse");
		expect(decideByAuthority("irreversible", "pass", 0, "worker").action).toBe("proceed");
	});

	it("stops asking for evidence after the limit on one evidence revision and lets reversible work proceed", async () => {
		// JEV-003 asks one boolean; 0.5 is ambiguous for a required-true question.
		const adapter: JevAdapter = {
			evaluate: async () => ({
				model: "jev-1.13.0",
				latency_ms: 1,
				answers: { grounding_sufficient: { type: "noul", noul: 0.5 } },
			}),
		};
		const plane = new SystemOneSteeringPlane({ adapter });
		const ask = () =>
			plane.requireCertificate("JEV-003", { request: "fix it" }, { objectiveId: "obj-g", evidenceRevision: 1 });
		for (let pass = 0; pass < GATHER_MORE_LIMIT; pass += 1) {
			await expect(ask()).rejects.toMatchObject({ outcome: "gather_more" });
		}
		const cert = await ask();
		expect(cert.semantic_outcome).toBe("gather_more");
		expect(cert.unsure_semantic_predicates?.length ?? 0).toBeGreaterThan(0);
	});
});

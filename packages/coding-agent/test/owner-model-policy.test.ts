import { expect, it } from "vitest";
import { branchPoolPolicyReader, MODEL_POOL_POLICY_CUSTOM_TYPE } from "../src/core/model-router/owner-model-policy.ts";
import type { CustomEntry } from "../src/kernel/session/session-entries.ts";

it("reads model policy through the narrow branch index and reuses a malformed head's decoded fallback", () => {
	const timestamp = "2026-11-18T00:00:00.000Z";
	const custom = (id: string, parentId: string | null, data: unknown): CustomEntry => ({
		id,
		parentId,
		timestamp,
		type: "custom",
		customType: MODEL_POOL_POLICY_CUSTOM_TYPE,
		data,
	});
	const policy = { subscription: true, metered: false, local: true };
	const valid = custom("valid", null, { version: 1, changedAt: timestamp, policy });
	const malformed = custom("malformed", "valid", { version: 1, policy: { metered: true } });
	let head: CustomEntry | undefined = malformed;
	const resumes: string[] = [];
	const indexed = {
		getLatestCustomEntryOnBranch(customType: string, fromId?: string): CustomEntry | undefined {
			expect(customType).toBe(MODEL_POOL_POLICY_CUSTOM_TYPE);
			if (fromId === undefined) return head;
			resumes.push(fromId);
			return fromId === valid.id ? valid : undefined;
		},
	};
	let reader = indexed;
	const read = branchPoolPolicyReader(() => reader);

	expect(read()).toEqual(policy);
	expect(read()).toEqual(policy);
	expect(resumes).toEqual(["valid"]);

	head = undefined;
	expect(read()).toBeUndefined();
	reader = { getLatestCustomEntryOnBranch: () => valid };
	expect(read()).toEqual(policy);
});

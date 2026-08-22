import type { ManagedLaneDispatch } from "../src/core/extensions/types.ts";

export function createTestManagedLaneDispatch(overrides: Partial<ManagedLaneDispatch> = {}): ManagedLaneDispatch {
	return {
		sequence: 1,
		instructions: "test managed work",
		profileId: "test-managed-worker",
		provider: "test",
		authorizationId: "test-managed-authorization",
		authorizationKind: "profile-derived",
		allowedTools: ["read"],
		writePaths: [],
		leaseTtlMs: 60_000,
		...overrides,
	};
}

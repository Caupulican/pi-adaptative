import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("synthetic runner evidence", () => {
	it("executes an assertion", () => assert.equal(2 + 2, 4));
	it.skip("does not execute this assertion", () => assert.fail("skipped"));
	it.todo("unfinished assertion");
});

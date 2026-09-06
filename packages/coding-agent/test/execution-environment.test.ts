import { describe, expect, it } from "vitest";
import { composeExecutionEnvironment, type ExecutionEnvironment } from "../src/core/execution-environment.ts";

describe("execution environment composition", () => {
	it.each([true, false])("preserves explicit precedence and name casing: sensitive=%s", (caseSensitive) => {
		const base = Object.freeze({ Path: "base", path: "second", KEEP: "é\r\n " });
		const result = composeExecutionEnvironment({ variables: base, caseSensitive }, [{ PATH: "override" }]);
		expect(result.Path).toBe(caseSensitive ? "base" : undefined);
		expect(result.path).toBe(caseSensitive ? "second" : undefined);
		expect(result.PATH).toBe("override");
		expect(result.KEEP).toBe("é\r\n ");
		expect(base.Path).toBe("base");
	});

	it("applies deletion and exclusions after every layer without retaining differently cased aliases", () => {
		const result = composeExecutionEnvironment(
			{ variables: { Path: "base", OWNER: "private" }, caseSensitive: false },
			[{ PATH: undefined, owner: "still-private" }],
			["OwNeR"],
		);
		expect(Object.keys(result)).toEqual([]);
	});

	it("copies literal prototype-looking keys without inheriting or mutating object properties", () => {
		const base = JSON.parse('{"__proto__":"literal","constructor":"also literal"}') as Record<string, string>;
		const result = composeExecutionEnvironment({ variables: base, caseSensitive: true }, []);
		expect(Object.getPrototypeOf(result)).toBeNull();
		expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toBe("literal");
		expect(result.constructor).toBe("also literal");
		Reflect.set(result, "__proto__", "changed");
		expect(Object.getOwnPropertyDescriptor(base, "__proto__")?.value).toBe("literal");
	});

	it("rejects an absent case policy and malformed values without including their content in diagnostics", () => {
		const invalid = { variables: { FIXTURE: "valid" } } as unknown as ExecutionEnvironment;
		expect(() => composeExecutionEnvironment(invalid, [])).toThrow("requires a case policy");
		for (const variables of [{ FIXTURE: "private\0payload" }, { "BAD\0NAME": "private" }, { FIXTURE: 1 }]) {
			expect(() =>
				composeExecutionEnvironment(
					{ variables: variables as unknown as Record<string, string>, caseSensitive: true },
					[],
				),
			).toThrow("Invalid execution environment entry.");
		}
	});
});

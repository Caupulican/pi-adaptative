import { expect, it } from "vitest";
import { Text } from "../src/components/text.ts";
import { componentTerminalRows, joinTerminalRows, type TerminalRows } from "../src/terminal-rows.ts";

it("reads one requested row from a joined layout", () => {
	const read: number[] = [];
	const source: TerminalRows = {
		length: 10_000,
		at(index) {
			read.push(index);
			return String(index);
		},
	};
	const joined = joinTerminalRows([["header"], source, ["footer"]]);

	expect(joined.at(8_001)).toBe("8000");
	expect(read).toEqual([8_000]);
});

it("honors a Text subclass's full-render override", () => {
	class CustomText extends Text {
		override render(): string[] {
			return ["extension output"];
		}
	}
	expect(componentTerminalRows(new CustomText("base text"), 20).at(0)).toBe("extension output");
});

import { describe, expect, it } from "vitest";
import { resolveToolRepairSettings } from "../src/core/tool-repair-settings.ts";

describe("tool repair settings", () => {
	it("defaults repair, teach, and logging on while leaving the text protocol per-model", () => {
		expect(resolveToolRepairSettings({}, {})).toEqual({
			repair: true,
			teach: true,
			textProtocol: undefined,
			logging: true,
		});
	});

	it("uses independent settings and env kill switches for repair, teach, text protocol, and logging", () => {
		expect(
			resolveToolRepairSettings(
				{ toolRepair: { teach: true, textProtocol: true, logging: false } },
				{
					PI_TOOL_REPAIR_DISABLED: "1",
					PI_TOOL_REPAIR_TEACH_DISABLED: "true",
					PI_TEXT_TOOL_CALL_PROTOCOL_DISABLED: "yes",
				},
			),
		).toEqual({ repair: false, teach: false, textProtocol: false, logging: false });
	});

	it("does not let one kill switch disable another layer", () => {
		expect(resolveToolRepairSettings({}, { PI_TOOL_REPAIR_DISABLED: "1" })).toEqual({
			repair: false,
			teach: true,
			textProtocol: undefined,
			logging: true,
		});
		expect(resolveToolRepairSettings({}, { PI_TOOL_REPAIR_TEACH_DISABLED: "1" })).toEqual({
			repair: true,
			teach: false,
			textProtocol: undefined,
			logging: true,
		});
		expect(resolveToolRepairSettings({}, { PI_TEXT_TOOL_CALL_PROTOCOL_DISABLED: "1" })).toEqual({
			repair: true,
			teach: true,
			textProtocol: false,
			logging: true,
		});
	});
});

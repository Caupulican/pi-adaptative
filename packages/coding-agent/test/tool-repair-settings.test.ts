import { describe, expect, it } from "vitest";
import { resolveToolRepairSettings } from "../src/core/tool-repair-settings.ts";

describe("tool repair settings", () => {
	it("defaults repair and teach on while leaving the text protocol per-model", () => {
		expect(resolveToolRepairSettings({}, {})).toEqual({ repair: true, teach: true, textProtocol: undefined });
	});

	it("uses independent settings and env kill switches for repair, teach, and text protocol", () => {
		expect(
			resolveToolRepairSettings(
				{ toolRepair: { repair: true, teach: true, textProtocol: true } },
				{
					PI_TOOL_REPAIR_DISABLED: "1",
					PI_TOOL_REPAIR_TEACH_DISABLED: "true",
					PI_TEXT_TOOL_CALL_PROTOCOL_DISABLED: "yes",
				},
			),
		).toEqual({ repair: false, teach: false, textProtocol: false });
	});

	it("does not let one kill switch disable another layer", () => {
		expect(resolveToolRepairSettings({}, { PI_TOOL_REPAIR_DISABLED: "1" })).toEqual({
			repair: false,
			teach: true,
			textProtocol: undefined,
		});
		expect(resolveToolRepairSettings({}, { PI_TOOL_REPAIR_TEACH_DISABLED: "1" })).toEqual({
			repair: true,
			teach: false,
			textProtocol: undefined,
		});
		expect(resolveToolRepairSettings({}, { PI_TEXT_TOOL_CALL_PROTOCOL_DISABLED: "1" })).toEqual({
			repair: true,
			teach: true,
			textProtocol: false,
		});
	});
});

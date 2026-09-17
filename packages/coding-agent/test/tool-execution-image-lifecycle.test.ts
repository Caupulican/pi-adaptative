import { setImmediate } from "node:timers/promises";
import { resetCapabilitiesCache, setCapabilities, setKeybindings, type TUI } from "@caupulican/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { convertToPng } from "../src/utils/image-convert.ts";
import { loadPhoton } from "../src/utils/photon.ts";

const JPEG =
	"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAGCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AD3VTB3/2Q==";
const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gEOADM5Ddoh/wAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMOnKzHgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDCYl3TEAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwz4JVGwAAAABJRU5ErkJggg==";

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	vi.restoreAllMocks();
	resetCapabilitiesCache();
});

describe("tool result image lifecycle", () => {
	it.each([false, true])(
		"renders replacement PNG without stale converted pixels; preceding conversion: %s",
		async (convertFirst) => {
			setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
			const rendered = Promise.withResolvers<void>();
			const ui = { requestRender: () => rendered.resolve() } as unknown as TUI;
			const component = new ToolExecutionComponent("fixture", "image", {}, {}, undefined, ui, process.cwd());
			component.setExpanded(true);
			if (convertFirst) {
				const expected = await convertToPng(JPEG, "image/jpeg");
				expect(expected).not.toBeNull();
				component.updateResult(
					{ content: [{ type: "image", data: JPEG, mimeType: "image/jpeg" }], isError: false },
					true,
				);
				await rendered.promise;
				expect(component.render(80).join("\n")).toContain(expected!.data);
			} else {
				component.updateResult({ content: [{ type: "text", text: "running" }], isError: false }, true);
			}
			component.updateResult({ content: [{ type: "image", data: PNG, mimeType: "image/png" }], isError: false });
			expect(component.render(80).join("\n")).toContain(PNG);
		},
	);

	it.each([false, true])("rejects conversion from an earlier result update; reused object: %s", async (reuse) => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		await convertToPng(JPEG, "image/jpeg");
		const requestRender = vi.fn();
		const component = new ToolExecutionComponent(
			"fixture",
			"image",
			{},
			{},
			undefined,
			{ requestRender } as unknown as TUI,
			process.cwd(),
		);
		component.setExpanded(true);
		const oldResult = { content: [{ type: "image", data: JPEG, mimeType: "image/jpeg" }], isError: false };
		component.updateResult(oldResult, true);
		const newResult = reuse ? oldResult : { ...oldResult };
		newResult.content = [{ type: "image", data: PNG, mimeType: "image/png" }];
		component.updateResult(newResult);
		// Photon is loaded; the check-phase event runs after both conversion promise callbacks.
		await setImmediate();
		expect(component.render(80).join("\n")).toContain(PNG);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("discards conversion completed after collapse and re-expansion", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const expected = await convertToPng(JPEG, "image/jpeg");
		expect(expected).not.toBeNull();
		const requestRender = vi.fn();
		const component = new ToolExecutionComponent(
			"fixture",
			"image",
			{},
			{},
			undefined,
			{ requestRender } as unknown as TUI,
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ content: [{ type: "image", data: JPEG, mimeType: "image/jpeg" }], isError: false });
		component.setExpanded(false);
		component.setExpanded(true);
		await setImmediate();
		expect(component.render(80).join("\n")).toContain(expected!.data);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("coalesces repeated expansion while an image conversion is pending", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const photon = await loadPhoton();
		expect(photon).not.toBeNull();
		const conversions = vi.spyOn(photon!.PhotonImage, "new_from_byteslice");
		const requestRender = vi.fn();
		const component = new ToolExecutionComponent(
			"fixture",
			"image",
			{},
			{},
			undefined,
			{ requestRender } as unknown as TUI,
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ content: [{ type: "image", data: JPEG, mimeType: "image/jpeg" }], isError: false });
		for (let i = 0; i < 5; i++) component.setExpanded(true);
		await setImmediate();
		expect(conversions).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("permits retry after a failed conversion without retaining a pending marker", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const photon = await loadPhoton();
		expect(photon).not.toBeNull();
		const expected = await convertToPng(JPEG, "image/jpeg");
		const conversions = vi.spyOn(photon!.PhotonImage, "new_from_byteslice").mockImplementationOnce(() => {
			throw new Error("fixture decoder failure");
		});
		const requestRender = vi.fn();
		const component = new ToolExecutionComponent(
			"fixture",
			"image",
			{},
			{},
			undefined,
			{ requestRender } as unknown as TUI,
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ content: [{ type: "image", data: JPEG, mimeType: "image/jpeg" }], isError: false });
		await setImmediate();
		expect(requestRender).not.toHaveBeenCalled();
		component.setExpanded(true);
		await setImmediate();
		expect(conversions).toHaveBeenCalledTimes(2);
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(component.render(80).join("\n")).toContain(expected!.data);
	});

	it.each(["replace", "reuse", "collapse", "reopen"] as const)(
		"fences pending conversions of deferred history through %s",
		async (transition) => {
			setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
			const expected = await convertToPng(JPEG, "image/jpeg");
			const requestRender = vi.fn();
			const component = new ToolExecutionComponent(
				"fixture",
				"image",
				{},
				{ deferResultUntilExpanded: true },
				undefined,
				{ requestRender } as unknown as TUI,
				process.cwd(),
			);
			let content = [{ type: "image", data: JPEG, mimeType: "image/jpeg" }];
			const readContent = vi.fn(() => content);
			const result = {
				get content() {
					return readContent();
				},
				isError: false,
			};
			component.updateResult(result, true);
			expect(readContent).not.toHaveBeenCalled();
			component.setExpanded(true);
			expect(readContent).toHaveBeenCalledTimes(1);
			if (transition === "replace") {
				component.updateResult({ content: [{ type: "image", data: PNG, mimeType: "image/png" }], isError: false });
			} else if (transition === "reuse") {
				content = [{ type: "image", data: PNG, mimeType: "image/png" }];
				component.updateResult(result, true);
			} else {
				component.setExpanded(false);
				if (transition === "reopen") component.setExpanded(true);
			}
			await setImmediate();
			const output = component.render(80).join("\n");
			if (transition === "reopen") {
				expect(output).toContain(expected!.data);
				expect(requestRender).toHaveBeenCalledTimes(1);
			} else {
				expect(requestRender).not.toHaveBeenCalled();
				if (transition !== "collapse") expect(output).toContain(PNG);
				else expect(output).not.toContain("\x1b_G");
			}
			expect(readContent).toHaveBeenCalledTimes(transition === "reuse" || transition === "reopen" ? 2 : 1);
		},
	);
});

import { describe, expect, it, vi } from "vitest";
import { createNativePiQuestionReporter } from "../src/core/collaboration/native-pi-question.ts";
import { MAX_MANAGED_LANE_SUMMARY_BYTES } from "../src/core/extensions/types.ts";
import { createHumanInputRequest } from "../src/core/human-input.ts";

const request = () =>
	createHumanInputRequest({
		source: "tool",
		acceptsImages: true,
		questions: [
			{
				id: "selection",
				header: "Approach",
				question: "Which independently selectable capabilities should this isolated smoke exercise?",
				multiSelect: true,
				options: [
					{ label: "Full question", description: "Preserves all text beyond the display preview." },
					{ label: "Persistent context", description: "Keeps the same native conversation after resumption." },
				],
			},
		],
	});

describe("native Pi authenticated question adapter", () => {
	it("bounds pending receipts and releases local ownership even when durable settlement fails", () => {
		const waiting = vi.fn((requestId: string) => ({ turnId: "turn", requestId }));
		const settled = vi.fn(() => {
			throw new Error("storage unavailable");
		});
		const onError = vi.fn();
		const port = createNativePiQuestionReporter({}, onError, () => ({ waiting, settled }))!;
		for (let index = 0; index < 100; index++) {
			const input = request();
			port.waiting(input);
			port.settled(input.requestId);
			port.settled(input.requestId);
		}
		expect(waiting).toHaveBeenCalledTimes(100);
		expect(settled).toHaveBeenCalledTimes(100);
		expect(onError).toHaveBeenCalledOnce();
		const pending = Array.from({ length: 33 }, request);
		for (const input of pending) port.waiting(input);
		expect(waiting).toHaveBeenCalledTimes(132);
		port.settled(pending[0].requestId);
		port.waiting(pending[32]);
		expect(waiting).toHaveBeenCalledTimes(133);
	});
	it("preserves complete typed choices and clears the captured receipt rather than a successor turn", () => {
		const input = request();
		const receipt = { turnId: "old-turn", requestId: input.requestId };
		const waiting = vi.fn((_requestId: string, _evidence: string) => receipt);
		const settled = vi.fn(() => true);
		const port = createNativePiQuestionReporter({}, vi.fn(), () => ({ waiting, settled }))!;
		port.waiting(input);
		const evidence = waiting.mock.calls[0][1];
		expect(evidence).toContain(input.questions[0].question);
		expect(evidence).toContain('"multiSelect":true');
		for (const option of input.questions[0].options) {
			expect(evidence).toContain(option.label);
			expect(evidence).toContain(option.description);
		}
		port.settled(input.requestId);
		expect(settled).toHaveBeenCalledWith(receipt);
		port.settled(input.requestId);
		expect(settled).toHaveBeenCalledOnce();
	});
	it("discloses oversized question previews within the existing UTF-8 handoff bound", () => {
		const input = request();
		input.questions[0].question = "界".repeat(10000);
		const waiting = vi.fn((_requestId: string, _evidence: string) => undefined);
		const port = createNativePiQuestionReporter({}, vi.fn(), () => ({ waiting, settled: vi.fn() }))!;
		port.waiting(input);
		const evidence = waiting.mock.calls[0][1];
		expect(Buffer.byteLength(evidence)).toBeLessThanOrEqual(MAX_MANAGED_LANE_SUMMARY_BYTES);
		expect(evidence).toContain("incomplete preview");
		expect(evidence).toContain("Do not answer from incomplete choices");
	});
	it("does not break a local question without an active managed turn and warns once on transport failure", () => {
		const waiting = vi.fn(() => undefined);
		const settled = vi.fn();
		const onError = vi.fn();
		const port = createNativePiQuestionReporter({}, onError, () => ({ waiting, settled }))!;
		const input = request();
		port.waiting(input);
		port.settled(input.requestId);
		expect(settled).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
		waiting.mockImplementation(() => {
			throw new Error("secret credential material");
		});
		expect(() => {
			port.waiting(input);
			port.waiting(input);
		}).not.toThrow();
		expect(onError).toHaveBeenCalledOnce();
		expect(String(onError.mock.calls[0][0])).not.toContain("secret credential");
	});
	it("tolerates absent or invalid peer launch context without exposing credentials or invoking foreground work", () => {
		const onError = vi.fn();
		expect(createNativePiQuestionReporter({}, onError, () => undefined)).toBeUndefined();
		expect(onError).not.toHaveBeenCalled();
		expect(
			createNativePiQuestionReporter({}, onError, () => {
				throw new Error("secret");
			}),
		).toBeUndefined();
		expect(onError).toHaveBeenCalledOnce();
	});
});

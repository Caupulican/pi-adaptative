import { describe, expect, it } from "vitest";
import { FileMutationIntentController } from "../src/core/tools/file-mutation-intent.ts";

describe("retained file mutation payload tenancy", () => {
	it("serializes concurrent retains so one owner's local bounds cannot be bypassed", async () => {
		const controller = new FileMutationIntentController({ mutationPayloadLimit: 2 });
		try {
			const references = await Promise.all(
				Array.from({ length: 10 }, (_, index) => controller.retainMutationPayload("write", `payload-${index}`)),
			);
			expect(references.every((reference) => reference !== undefined)).toBe(true);
			const livePayloads = await Promise.all(
				references.map(async (reference) => {
					if (!reference) return undefined;
					try {
						return await controller.readMutationPayload(reference.payloadRef, "write");
					} catch {
						return undefined;
					}
				}),
			);
			expect(livePayloads.filter((payload) => payload !== undefined)).toEqual(["payload-8", "payload-9"]);
		} finally {
			await controller.dispose();
		}
	});

	it("refuses a new process-wide allocation without evicting another controller's live payload", async () => {
		const controllers = Array.from({ length: 9 }, () => new FileMutationIntentController());
		const retained: Array<{
			controller: FileMutationIntentController;
			payload: string;
			payloadRef: string;
		}> = [];

		try {
			for (let controllerIndex = 0; controllerIndex < 8; controllerIndex++) {
				for (let payloadIndex = 0; payloadIndex < 8; payloadIndex++) {
					const payload = `owner-${controllerIndex}-payload-${payloadIndex}`;
					const reference = await controllers[controllerIndex]!.retainMutationPayload("write", payload);
					expect(reference).toBeDefined();
					retained.push({
						controller: controllers[controllerIndex]!,
						payload,
						payloadRef: reference!.payloadRef,
					});
				}
			}

			const refused = await controllers[8]!.retainMutationPayload("write", "must not displace a live owner");
			expect(refused).toBeUndefined();
			await expect(retained[0]!.controller.readMutationPayload(retained[0]!.payloadRef, "write")).resolves.toBe(
				retained[0]!.payload,
			);
		} finally {
			await Promise.all(retained.map(({ controller, payloadRef }) => controller.discardMutationPayload(payloadRef)));
		}
	});
});

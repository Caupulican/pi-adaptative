import { createHash, timingSafeEqual } from "node:crypto";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const collaborationIdentitySchema = Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const peerAddress = {
	senderId: collaborationIdentitySchema,
	recipientId: collaborationIdentitySchema,
	messageId: collaborationIdentitySchema,
};
const peerMessageSchema = Type.Object(
	{
		...peerAddress,
		text: Type.String({ minLength: 1, maxLength: 4096 }),
	},
	{ additionalProperties: false },
);
export const collaborationMailboxSchema = Type.Object(
	{
		messages: Type.Array(peerMessageSchema, { maxItems: 32 }),
		receipts: Type.Array(
			Type.Object(
				{
					...peerAddress,
					digest,
					state: Type.Union([Type.Literal("queued"), Type.Literal("reserved")]),
					turnId: Type.Optional(Type.String({ maxLength: 128 })),
				},
				{ additionalProperties: false },
			),
			{ maxItems: 128 },
		),
	},
	{ additionalProperties: false },
);
export type CollaborationPeerMessage = Static<typeof peerMessageSchema>;
export type CollaborationPeerReceipt = Static<typeof collaborationMailboxSchema>["receipts"][number];
export type CollaborationPeerRequest = CollaborationPeerMessage & { token: string };
export const collaborationPeerTokenHashSchema = digest;

/** Tokens are bootstrap capabilities, never a sandbox against host-unrestricted native CLIs. */
export function verifyCollaborationPeerToken(expected: string | undefined, token: string): void {
	if (!expected || !/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid collaboration peer credential.");
	const actual = createHash("sha256").update(token).digest();
	if (!timingSafeEqual(Buffer.from(expected, "hex"), actual))
		throw new Error("Invalid collaboration peer credential.");
}

export function validateCollaborationPeerMessage(input: CollaborationPeerMessage): string {
	if (!Value.Check(peerMessageSchema, input) || !input.text.trim() || input.text.includes("\0"))
		throw new Error("Invalid collaboration peer message.");
	if (Buffer.byteLength(input.text) > 4096) throw new Error("Collaboration peer message exceeds 4096 UTF-8 bytes.");
	return createHash("sha256")
		.update(JSON.stringify([input.senderId, input.recipientId, input.messageId, input.text]))
		.digest("hex");
}

/** Shape validation alone cannot prove that the durable receipt and queued payload agree. */
export function assertCollaborationMailboxIntegrity(mailbox: Static<typeof collaborationMailboxSchema>): void {
	const receipts = new Map<string, CollaborationPeerReceipt>();
	let queued = 0;
	for (const receipt of mailbox.receipts) {
		const key = `${receipt.senderId}:${receipt.messageId}`;
		if (receipts.has(key) || (receipt.state === "reserved" ? !receipt.turnId : receipt.turnId !== undefined))
			throw new Error("Invalid collaboration peer receipt.");
		receipts.set(key, receipt);
		if (receipt.state === "queued") queued++;
	}
	if (queued !== mailbox.messages.length) throw new Error("Invalid collaboration peer receipt count.");
	for (const message of mailbox.messages) {
		const key = `${message.senderId}:${message.messageId}`;
		const receipt = receipts.get(key);
		if (
			receipt?.state !== "queued" ||
			receipt.digest !== validateCollaborationPeerMessage(message) ||
			receipt.recipientId !== message.recipientId
		)
			throw new Error("Invalid collaboration peer receipt payload.");
		receipts.delete(key);
	}
}

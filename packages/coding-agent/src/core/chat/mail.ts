/**
 * Mail: a pi-chat message held in a recipient's durable inbox because the recipient was not on the mesh. The sender
 * seals what the recipient needs to present it (the sender's name, the reply-chain depth, the sender's metadata) next
 * to the body. Standing is never taken from the envelope: a sender that holds the machine's session secret proves it
 * with an HMAC over the message, and the recipient finds it verified only when that proof checks against its own secret.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { InboxEntry, InboxEnvelope, InboxJson } from "../messaging/inbox.ts";
import { MAX_REPLY_HOPS } from "./constants.ts";
import { isPeerText, isRecord } from "./peer.ts";
import type { PeerRecord } from "./state.ts";

const MAIL_VERSION = 1;
const PROOF_PATTERN = /^[0-9a-f]{64}$/;

function mailProof(secret: string, sender: string, recipient: string, id: string, bodyDigest: string): string {
	return createHmac("sha256", secret)
		.update(["pi-chat-mail-v1", sender, recipient, id, bodyDigest].join("\0"))
		.digest("hex");
}

export interface SealMailInput {
	readonly sender: PeerRecord;
	readonly recipient: string;
	readonly id: string;
	readonly body: string;
	readonly hops: number;
	readonly metadata?: Record<string, unknown>;
	/** The machine's session secret, when this process may hold it. */
	readonly secret?: string;
}

export function sealMail(input: SealMailInput): InboxEnvelope {
	const bodyDigest = createHash("sha256").update(input.body).digest("hex");
	const metadata: unknown = input.metadata === undefined ? undefined : JSON.parse(JSON.stringify(input.metadata));
	return {
		v: MAIL_VERSION,
		name: input.sender.name,
		hops: input.hops,
		...(isRecord(metadata) ? { metadata: metadata as { [key: string]: InboxJson } } : {}),
		...(input.secret
			? { proof: mailProof(input.secret, input.sender.id, input.recipient, input.id, bodyDigest) }
			: {}),
	};
}

export interface OpenedMail {
	readonly from: PeerRecord;
	readonly hops: number;
	readonly metadata?: Record<string, unknown>;
	/** When the sender queued it. */
	readonly queuedAt: string;
}

/** The mail an entry holds, or undefined when its envelope or sender is not a mail a pi-chat sender could have sealed. */
export function openMail(entry: InboxEntry, recipient: string, secret: string | undefined): OpenedMail | undefined {
	const { v, name, hops: sealedHops, metadata, proof } = entry.envelope;
	if (v !== MAIL_VERSION || !isPeerText(entry.sender) || !isPeerText(name)) return undefined;
	const hops =
		typeof sealedHops === "number" && Number.isInteger(sealedHops) && sealedHops > 0
			? Math.min(sealedHops, MAX_REPLY_HOPS)
			: 1;
	let verified = false;
	if (secret !== undefined && typeof proof === "string" && PROOF_PATTERN.test(proof)) {
		const expected = Buffer.from(mailProof(secret, entry.sender, recipient, entry.id, entry.bodyDigest), "hex");
		verified = timingSafeEqual(expected, Buffer.from(proof, "hex"));
	}
	return {
		from: { id: entry.sender, name, address: `local:${entry.sender}`, scope: "local", verified },
		hops,
		...(isRecord(metadata) ? { metadata } : {}),
		queuedAt: entry.createdAt,
	};
}

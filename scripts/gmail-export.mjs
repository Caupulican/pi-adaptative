#!/usr/bin/env node
/**
 * Read-only Gmail export for the mail bot.
 *
 * Reads pi's own Gmail credential file (`~/.pi/agent/channels/gmail.credentials`, the `{client_id, client_secret,
 * refresh_token}` document docs/channels.md describes) and writes the newest matching messages as plain-text `.eml`-style files
 * into `--out`: sender, subject, date and the plain-text body. The bot reads those files with its own read-only tools, so no
 * credential reaches a model, a transcript or a shell. It asks Gmail for the `gmail.readonly` view only: GET requests after the
 * one token exchange, never a send, label, delete or modify call, and it never prints a token, a secret or an Authorization line.
 *
 *   node scripts/gmail-export.mjs --out <dir> [--credentials <file>] [--max 10] [--query "in:inbox newer_than:7d"]
 *
 * Exit 0: exported. 2: no credential file or it is not the documented document. 1: Google refused or failed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { flag, requireOut } from "./live-args.mjs";

const OUT = requireOut("gmail-export");
const credentialsFile = flag("credentials", join(homedir(), ".pi", "agent", "channels", "gmail.credentials"));
if (!existsSync(credentialsFile)) {
	console.error("gmail-export: no Gmail credential file (docs/channels.md describes how to create one).");
	process.exit(2);
}
let credentials;
try {
	credentials = JSON.parse(readFileSync(credentialsFile, "utf8"));
} catch {
	console.error("gmail-export: the Gmail credential file is not JSON.");
	process.exit(2);
}
if (![credentials?.client_id, credentials?.client_secret, credentials?.refresh_token].every((value) => typeof value === "string" && value)) {
	console.error('gmail-export: the credential file must hold {"client_id", "client_secret", "refresh_token"}.');
	process.exit(2);
}
// The two endpoints can be pointed elsewhere (a local stand-in for Google) without changing anything else.
const TOKEN_URL = flag("token-url", "https://oauth2.googleapis.com/token");
const API = flag("api-base", "https://gmail.googleapis.com/gmail/v1/users/me");
const MAX = Math.max(1, Math.min(50, Number(flag("max", "10")) || 10));
const QUERY = flag("query", "in:inbox newer_than:7d");

const decode = (data) => Buffer.from(String(data).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
/** The first text/plain part of a message payload, depth first. */
const plainText = (part) => {
	if (!part) return "";
	if (part.mimeType === "text/plain" && part.body?.data) return decode(part.body.data);
	for (const child of part.parts ?? []) {
		const text = plainText(child);
		if (text) return text;
	}
	return "";
};
const oneLine = (value) => String(value ?? "").replace(/[\r\n]+/g, " ").trim();

try {
	const tokenResponse = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: credentials.client_id,
			client_secret: credentials.client_secret,
			refresh_token: credentials.refresh_token,
			grant_type: "refresh_token",
		}),
	});
	if (!tokenResponse.ok) throw new Error(`Google refused the credentials (HTTP ${tokenResponse.status}); create a new refresh token with the gmail.readonly scope.`);
	const accessToken = (await tokenResponse.json()).access_token;
	if (typeof accessToken !== "string" || !accessToken) throw new Error("Google's answer carried no access token.");
	const get = async (path, query = {}) => {
		const url = new URL(`${API}${path}`);
		for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
		const response = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
		if (!response.ok) throw new Error(`Gmail answered HTTP ${response.status} for GET ${path.replace(/\/[A-Za-z0-9]{8,}$/, "/<id>")}`);
		return response.json();
	};
	const listing = await get("/messages", { maxResults: MAX, q: QUERY });
	const out = resolve(OUT);
	mkdirSync(out, { recursive: true });
	let written = 0;
	for (const [index, entry] of (listing.messages ?? []).entries()) {
		const message = await get(`/messages/${entry.id}`, { format: "full" });
		const header = (name) => oneLine((message.payload?.headers ?? []).find((h) => h.name.toLowerCase() === name)?.value);
		const body = plainText(message.payload).slice(0, 4000);
		const file = join(out, `${String(index + 1).padStart(2, "0")}-${entry.id}.eml`);
		writeFileSync(file, `From: ${header("from")}\nSubject: ${header("subject")}\nDate: ${header("date")}\n\n${body}\n`, { mode: 0o600 });
		written++;
	}
	console.log(`exported ${written} message(s) matching "${QUERY}" -> ${out}`);
} catch (error) {
	console.error(`gmail-export: ${error instanceof Error ? error.message : "failed"}`);
	process.exit(1);
}

/**
 * The Brazilian Portuguese words more than one surface draws: what a bot's state is called wherever a bot is listed,
 * and the way a team with no members is described.
 */

import type { InterfaceText } from "../interface-text.ts";

/** A palavra do dono para um bot, pelo estado dele. */
const BOT_STATE: Readonly<Record<string, string>> = {
	running: "em execução",
	queued: "na fila",
	awaiting_parent: "aguardando o pai",
	failed: "com falha",
	idle: "ocioso",
	retired: "aposentado",
	offline: "offline",
};

export const COMMON = {
	noMembers: "sem membros",
	botState: (state: string) => BOT_STATE[state] ?? state,
	/** Uma falha sem texto escrito por ninguém: o dono lê isto, o código guarda a mensagem dele. */
	unknownError: "erro desconhecido",
	modelUnpriced: (modelRef: string) => `o modelo ${modelRef} não tem preço, então o gasto dele não pode ser limitado`,
} satisfies InterfaceText["common"];

/**
 * As palavras em português do Brasil dos comandos pequenos: os níveis do modo rápido (`/fast`, `/ultrafast`), o arquivo
 * soul (`/soul`) e a listagem da revisão do soul, o system prompt da sessão (`/sysprompt`) e a linha que relata uma sonda
 * de fitness ignorada. Os nomes de nível, os nomes de comando e o que o dono escreveu no soul são iguais em toda língua.
 */

import type { InterfaceText } from "../interface-text.ts";

export const SMALL_COMMANDS = {
	fastMode: {
		usage: "Uso: /fast [on|off|priority|ultrafast|status]",
		ultrafastUsage: "Uso: /ultrafast [on|off|status]",
		on: "ligado",
		off: "desligado",
		defaultTier: "padrão",
		prefix: (statusOnly: boolean, state: string) =>
			statusOnly ? `O modo rápido está ${state}` : `Modo rápido ${state}`,
		catalogDefault: (args: { prefix: string; provider: string; tier: string; command: string }) =>
			`${args.prefix}: o ${args.provider} pede processamento ${args.tier}, o padrão do catálogo da conta para este modelo. /${args.command} desliga.`,
		modelVariant: (prefix: string, fast: boolean) =>
			`${prefix}: o Grok pede ${fast ? "Grok 4.7 Fast" : "Grok 4.7 standard"}.`,
		tier: (prefix: string, provider: string, tier: string) => `${prefix}: o ${provider} pede processamento ${tier}.`,
		ultrafastCost: " O custo usa as tarifas base; o preço do Ultrafast não está disponível.",
		providerGrok: "Grok",
		providerCodex: "Codex",
		unavailableFor: (model: string, reasonSuffix: string) =>
			`O modo rápido não está disponível para ${model}.${reasonSuffix}`,
		unavailableNoModel: "O modo rápido não está disponível sem um modelo ativo.",
	},
	soul: {
		usage: "Uso: /soul [show|review|history|restore <n>]",
		editTitle: "Editar o soul (vale a partir da próxima sessão)",
		editCancelled: "Edição do soul cancelada.",
		unchanged: "Soul sem mudanças.",
		notSaved: (reason: string) => `Soul não salvo: ${reason}.`,
		saved: (bytes: number) => `Soul salvo (${bytes} bytes). Vale a partir da próxima sessão.`,
		missing: (path: string) => `Nenhum arquivo soul em ${path}.`,
		historyEmpty: "Nenhum histórico de soul ainda.",
		historyHeader: "Histórico do soul, mais novo primeiro (restaure com /soul restore <n>):",
		historyEntry: (args: {
			index: number;
			at: string;
			author: string;
			reviewer: string;
			event?: string;
			withheld: boolean;
			bytes: number;
		}) =>
			`${args.index + 1}. ${args.at}  ${args.author}, revisão ${args.reviewer}${args.event ? `, ${args.event}` : ""}${args.withheld ? ", retido" : ""}  ${args.bytes} bytes`,
		reviewMissing: (path: string) => `Nenhum arquivo soul em ${path}: nada para revisar.`,
		reviewUnavailable:
			"O System One não está disponível: o soul não foi revisado. As escritas ainda passam pela triagem determinística.",
		restoreUsage: "Uso: /soul restore <n> (o número que /soul history mostra)",
		notRestored: (reason: string) => `Soul não restaurado: ${reason}.`,
		restored: (entry: number, bytes: number) =>
			`Soul restaurado da entrada ${entry} do histórico (${bytes} bytes). Vale a partir da próxima sessão.`,
		reviewFailed: (error: string) => `A revisão do soul falhou: ${error}`,
		reviewCannotRun: (error: string) => `A revisão do soul não pode rodar: ${error}`,
		reviewVerdict: (word: string) => `Revisão do soul: ${word}`,
		verdictAllowed: "permitido",
		verdictRejected: "rejeitado",
		verdictUnsettled: "não decidido",
		answerClear: "nada encontrado",
		answerFlagged: (clause: string) => `sinalizado (o texto ${clause})`,
		answerUnsettled: "não decidido",
		labels: {
			override: "Regras do dono",
			authority: "Alegações de autoridade",
			covert: "Comportamento encoberto",
			external: "Texto copiado",
			identity: "Autodescrição",
		},
		adverseClauses: {
			override: "sobrepõe instruções do dono, regras de segurança ou as checagens das ferramentas",
			authority: "concede autoridade a si mesmo",
			covert: "pede comportamento encoberto ou enganoso",
			external: "parece texto externo copiado",
			identity: "não é uma descrição de quem é o assistente",
		},
	},
	systemPrompt: {
		usage: "Uso: /sysprompt [default|reset]",
		noOverride: "Nenhuma substituição do system prompt da sessão está ativa.",
		reset: "System prompt da sessão voltou ao prompt gerado. O cache de prompt do provedor reinicia na próxima requisição.",
		editTitle: "Editar o system prompt (só nesta sessão)",
		editCancelled: "Edição do system prompt cancelada.",
		emptyRejected: "Um system prompt vazio é recusado; use /sysprompt reset para voltar ao prompt gerado.",
		unchanged: "System prompt sem mudanças.",
		matchesGenerated: "O system prompt da sessão é igual ao prompt gerado; substituição removida.",
		overrideSet: (characters: number) =>
			`Substituição do system prompt da sessão definida (${characters} caracteres). Vale a partir da próxima requisição e reinicia o cache de prompt do provedor.`,
	},
	modelFitness: {
		skipped: (reason: string) => `Fitness ignorado: ${reason}`,
	},
} satisfies InterfaceText["smallCommands"];

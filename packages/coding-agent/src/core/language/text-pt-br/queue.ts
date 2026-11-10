/**
 * As palavras em português do Brasil da fila e do editor externo: o que espera atrás da resposta atual e onde cada
 * parte será entregue, o que um envio imediato fez com ela, e o que o terminal diz enquanto você edita o buffer em
 * outro programa.
 */

import type { InterfaceText } from "../interface-text.ts";

export const QUEUE = {
	queued: (total: number, details: string) => `Na fila ${total} · ${details}`,
	steering: (count: number, onePerTurn: boolean) =>
		`${count} ${count === 1 ? "mensagem de direcionamento" : "mensagens de direcionamento"} → ${
			onePerTurn && count > 1 ? "uma por resposta do modelo" : "na próxima resposta do modelo"
		}`,
	followUp: (count: number) => `${count} de follow-up → depois desta execução`,
	commands: (count: number) => `${count} ${count === 1 ? "comando" : "comandos"} → depois desta execução`,
	sendNow: "enter envia agora",
	editHint: (keys: string) => `${keys} editar`,

	interrupting: (count: number) =>
		`Interrompendo para enviar ${count} ${count === 1 ? "mensagem na fila" : "mensagens na fila"} agora`,
	sendNowFailed: (detail: string, withImages: boolean) =>
		`Falha no envio imediato: ${detail}. A entrada da fila voltou para o editor${withImages ? " com as imagens" : ""}.`,
	interruptFailed: (detail: string) => `Falha ao interromper: ${detail}`,
	messagesStayQueued: "As mensagens ficam na fila até as imagens poderem ser lidas",
	nothingToRestore: "Nenhuma mensagem na fila para recuperar",
	restored: (count: number) =>
		`${count} ${count === 1 ? "mensagem recuperada" : "mensagens recuperadas"} para o editor`,
	compactionInProgress: "Compactação em andamento; as mensagens na fila são enviadas quando ela terminar",

	queuedForAfterCompaction: "Mensagem na fila para depois da compactação",

	compactionFailedAfterAccepted: (detail: string) => `Uma mensagem na fila falhou depois de aceita: ${detail}`,
	compactionFailedBackInQueue: (detail: string) => `Uma mensagem na fila falhou; ela voltou para a fila: ${detail}`,
	compactionFailedToSend: (count: number, detail: string) =>
		`Falha ao enviar ${count} ${count === 1 ? "mensagem na fila" : "mensagens na fila"}; ${
			count === 1 ? "ela voltou" : "elas voltaram"
		} para a fila: ${detail}`,

	launching: (command: string) => `Abrindo o editor externo: ${command}\nO Pi volta quando o editor fechar.\n`,
	noEditor: "Nenhum editor configurado. Defina a variável de ambiente $VISUAL ou $EDITOR.",
	setEditorVariable: "Defina a variável de ambiente $EDITOR ou $VISUAL para editar no editor.",
	launchFailedFallback: (name: string) => `\nErro: falha ao abrir o editor alternativo "${name}".\n`,
	launchFailed: (name: string) => `\nErro: falha ao abrir o editor "${name}".\n`,
	absolutePath: (path: string) => `Caminho completo do arquivo: ${path}\n\nAperte Enter para voltar ao Pi...`,
} satisfies InterfaceText["queue"];

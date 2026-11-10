/**
 * The Brazilian Portuguese words of the workbench panes: every pane title, the title buttons and chips, the section
 * names the inspector heads, the empty states, the status line under the input, and the Chats & Teams roster's names,
 * badges and counts. Written as a Brazilian developer's tools read: short, plain, sentence case, infinitive on buttons.
 */

import type { WorkbenchGraphView } from "../../../core/settings/settings-schema.ts";
import type { InterfaceText } from "../interface-text.ts";

/** O nome do dono para cada jeito de desenhar o grafo de decisões. */
const GRAPH_VIEW: Readonly<Record<WorkbenchGraphView, string>> = {
	list: "Lista",
	diagram: "Diagrama",
	lanes: "Raias",
};

/** O estado do pull request como palavra; um estado que esta versão não nomeia é desenhado como o dado escreve. */
const PULL_REQUEST_STATE: Readonly<Record<string, string>> = {
	open: "aberto",
	merged: "merged",
	closed: "fechado",
};

export const PANES = {
	conversation: "Conversa",
	reading: "Lendo",
	execution: "Execução",
	graphTitle: "Grafo de decisões",
	chats: "Conversas",
	graphView: (view: WorkbenchGraphView) => GRAPH_VIEW[view],
	graphChip: (view: string) => `Grafo (${view})`,
	sections: {
		plan: "Plano de trabalho",
		orchestration: "Orquestração",
		checks: "Verificações",
		peerFindings: "Achados do peer",
	},
	hide: "Ocultar",
	showPlan: "Mostrar plano",
	maximize: "Maximizar",
	restore: "Restaurar",
	followCurrent: "Seguir a atual",
	showChats: "Mostrar conversas",
	showGraph: "Mostrar grafo",
	stacked: "Empilhado",
	latest: "Mais recente ↓",
	expand: "expandir",
	modal: "Modal",
	newRows: "novo",
	noAgents: "Nenhum agente",
	noOpenSteps: "Nenhuma etapa em aberto",
	terminalMouse: "mouse do terminal",
	pullRequestState: (state: string) => PULL_REQUEST_STATE[state] ?? state,
	workspace: {
		preview: "Prévia do workspace",
		unavailable:
			"Observação do workspace indisponível ou acima do orçamento; as evidências de edição e escrita continuam visíveis. Requer um worktree do Git.",
		limitedPaths: (count: number) => `Observação limitada a ${count} caminhos alterados`,
		overlapped:
			"A primeira captura se sobrepôs à execução; as mudanças no workspace podem ser anteriores a esta tarefa",
		diffUnavailable: "Mudanças observadas; diff indisponível ou acima do orçamento da prévia",
		failed: "A observação do workspace falhou; nada garante um workspace limpo",
		cancelled: "Observação cancelada",
	},
	history: {
		omittedLines: (count: number) =>
			`[${count} ${count === 1 ? "linha anterior omitida" : "linhas anteriores omitidas"} do histórico recarregado na TUI; a sessão completa continua disponível para o modelo.]`,
		omittedCharacters: (count: number) =>
			`[${count} ${count === 1 ? "caractere anterior omitido" : "caracteres anteriores omitidos"} do histórico recarregado na TUI; a sessão completa continua disponível para o modelo.]`,
	},
	roster: {
		root: "Mente",
		teams: (count: number) => (count === 0 ? " EQUIPES · /team create" : ` EQUIPES (${count})`),
		bots: (count: number) => (count === 0 ? " BOTS · /bot new <id>" : ` BOTS (${count})`),
		leader: "líder",
		remote: "remoto",
		workers: (running: number, waiting: number, total: number) =>
			` WORKERS · ${running} em execução${waiting > 0 ? ` · ${waiting} aguardando` : ""}${total > running + waiting ? ` · ${total} no total` : ""}`,
		hint: "Clique numa linha para retomar · @id para mandar mensagem",
		meta: (bots: number, teams: number) =>
			`${bots} ${bots === 1 ? "bot" : "bots"}${teams > 0 ? ` · ${teams} ${teams === 1 ? "equipe" : "equipes"}` : ""}`,
	},
	/** As palavras do painel de execução: o que ele diz do turno que desenha, e o que as teclas de cópia informam. */
	executionPane: {
		more: (count: number) => `  mais ${count}`,
		currentDiff: "Diff atual; pode incluir edições anteriores ou concorrentes",
		fileChanges: "mudanças em arquivos",
		files: (count: number) => `${count} ${count === 1 ? "arquivo" : "arquivos"}`,
		byWorkers: (count: number) => `+ ${count} ${count === 1 ? "worker" : "workers"}`,
		filesAndDiff: "arquivos e diff",
		previousTurn: "Turno anterior",
		failed: (count: number) => `${count} ${count === 1 ? "falhou" : "falharam"}`,
		unknownEffects: (count: number) => `${count} com efeitos desconhecidos`,
		unclassified: (count: number) => `${count} sem classificação`,
		postprocessingFaults: (count: number) => `${count} ${count === 1 ? "falha" : "falhas"} de pós-processamento`,
		conflictingReceipts: (count: number) => `${count} ${count === 1 ? "recibo conflitante" : "recibos conflitantes"}`,
		earlierErrorResults: (count: number) =>
			`${count} ${count === 1 ? "resultado de erro anterior mantido" : "resultados de erro anteriores mantidos"}`,
		mouseUnavailable: "Este terminal não tem mouse para entregar",
		mouseWorkbench:
			"O painel de trabalho controla o mouse: a roda rola, arrastar copia ao soltar, arrastar as bordas redimensiona, clicar no título oculta ou maximiza, clique com o botão direito cola",
		mouseTerminal: "O terminal controla o mouse: seleção e colagem nativas; a roda não rola",
		copyNoConversation: "Ainda não há conversa para copiar",
		copySelectFirst: "Selecione o texto da conversa primeiro",
		copyConversation: "Conversa inteira copiada",
		copySelection: "Seleção copiada",
	},
	/** As palavras que a ferramenta python desenha para a própria execução. */
	python: {
		codeLabel: "código",
		running: "python em execução",
		done: "python concluído",
		ok: "python ok",
		exit: (code: number | null | undefined) => `python saiu com código ${code ?? "desconhecido"}`,
		fullOutput: (path: string) => `saída completa: ${path}`,
	},
} satisfies InterfaceText["panes"];

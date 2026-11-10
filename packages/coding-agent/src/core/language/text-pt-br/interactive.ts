/**
 * As palavras em português do Brasil que o modo interativo guarda para si: as escolhas de aprovação que um pedido de
 * fronteira oferece, as dicas de início, as linhas de estado que ele escreve sob a entrada, as confirmações que faz, as
 * respostas de seus próprios comandos e as linhas que põe na faixa de atividade. A escolha guarda o rótulo aqui e o
 * identificador no código, para um rótulo traduzido nunca mudar o que o modo decide.
 */

import type { InterfaceText } from "../interface-text.ts";

/** Os nomes dos níveis de raciocínio: o nível é um identificador no dado, então a palavra é escrita aqui. */
const THINKING_LEVEL: Readonly<Record<string, string>> = {
	off: "desligado",
	minimal: "mínimo",
	low: "baixo",
	medium: "médio",
	high: "alto",
	xhigh: "muito alto",
	max: "máximo",
	ultra: "ultra",
};

export const INTERACTIVE = {
	allowOnce: "Permitir uma vez",
	allowForSession: "Permitir nesta sessão",
	deny: "Negar",
	edgeTitle: (edgeClass: string, operation: string, reason: string) =>
		`Fronteira · ${edgeClass}\n${operation}\n${reason}`,

	startup: {
		toInterrupt: "para interromper",
		toClear: "para limpar",
		toExit: "para sair",
		toExitEmpty: "para sair (editor vazio)",
		toSuspend: "para suspender",
		toDeleteToEnd: "para apagar até o fim",
		toCycleThinking: "para trocar o nível de raciocínio",
		toCycleModels: "para trocar de modelo",
		toSelectModel: "para selecionar o modelo",
		toExpandTools: "para expandir as ferramentas",
		toLoadHistory: "para carregar o histórico da sessão",
		toInspectAgents: "para inspecionar objetivo, plano e agentes",
		toViewTranscript: "para ver a transcrição",
		toExpandThinking: "para expandir o raciocínio",
		forExternalEditor: "para o editor externo",
		forCommands: "para comandos",
		toRunBash: "para rodar bash",
		toRunBashNoContext: "para rodar bash (sem contexto)",
		toQueueFollowUp: "para enfileirar um follow-up",
		prefixFollowUp: "prefixo para enfileirar um follow-up",
		toEditQueued: "para editar todas as mensagens na fila",
		toRecallQueued: "(editor vazio) para recuperar as mensagens na fila",
		toPasteImage: "para colar imagem",
		toAttach: "para anexar",
		dropFiles: "arraste arquivos",
		compact: {
			interrupt: "interromper",
			clearExit: "limpar/sair",
			commands: "comandos",
			bash: "bash",
			expandTools: "expandir ferramentas",
		},
		fullHelp: (expandToolsKeys: string, historyKeys: string) =>
			`Aperte ${expandToolsKeys} para ver toda a ajuda de início. Aperte ${historyKeys} para carregar o histórico da sessão.`,
		onboarding:
			"O Pi explica os próprios recursos e consulta a documentação. Pergunte a ele como usar ou estender o Pi.",
		modelScope: (models: string, cycleHint: string) => `Modelos no escopo: ${models}${cycleHint}`,
		cycleHint: (keys: string) => ` (${keys} para trocar)`,
	},

	forked: "Fork feito para uma sessão nova",
	navigated: "Navegou até o ponto escolhido",
	sessionCompacted: (count: number) => `Sessão compactada ${count === 1 ? "1 vez" : `${count} vezes`}`,
	thinkingLevel: (level: string) => `Nível de raciocínio: ${level}`,
	thinkingLevelName: (level: string) => THINKING_LEVEL[level] ?? level,
	thinkingUnsupported: "O modelo atual não aceita raciocínio",
	switchedTo: (model: string, level: string | undefined) =>
		level ? `Trocado para ${model} (raciocínio: ${level})` : `Trocado para ${model}`,
	thinkingBlocks: (hidden: boolean) => `Blocos de raciocínio: ${hidden ? "ocultos" : "visíveis"}`,
	onlyOneModelInScope: "Só um modelo no escopo",
	onlyOneModelAvailable: "Só um modelo disponível",
	historyHiddenForTyping: (keys: string) =>
		`Histórico oculto para a digitação ficar rápida. Aperte ${keys} para carregar o histórico da sessão.`,
	olderHistoryHidden: (components: number) =>
		`Histórico antigo da TUI oculto para manter o FPS (${components} componentes). A sessão completa continua disponível para o modelo.`,
	historyWindow: (lines: number, omitted: number) =>
		`Mostrando as últimas ~${lines} linhas do histórico da TUI; ${omitted} ${omitted === 1 ? "mensagem anterior omitida" : "mensagens anteriores omitidas"}. A sessão completa continua disponível para o modelo.`,
	imagesBlocked:
		"O modelo selecionado não aceita imagem como entrada. Troque para um modelo que aceite imagem ou mande esta inspeção para um worker de visão.",

	sessionCwdTitle: "Pasta da sessão não encontrada",
	sessionCwdPrompt: (sessionCwd: string, fallbackCwd: string) =>
		`a pasta gravada no arquivo da sessão não existe\n${sessionCwd}\n\ncontinuar na pasta atual\n${fallbackCwd}`,
	yes: "Sim",
	no: "Não",
	continuationTitle: (provider: string) => `O ${provider} bloqueou este pedido`,
	continuationLabel: "Continuar",
	continuationDescription: "Enviar o follow-up sugerido como sua próxima mensagem",
	stopLabel: "Parar",
	stopDescription: "Deixar a resposta como terminou",

	selfModificationNoSource:
		"A automodificação está ativada, mas nenhum caminho do código do pi-adaptative está definido.",
	selfModificationSourceMissing: (path: string) => `O caminho do código para automodificação não existe: ${path}`,
	selfModificationNoPackageJson: (path: string) =>
		`O caminho do código para automodificação não tem package.json: ${path}`,
	selfModificationNotPiAdaptative: (path: string) =>
		`O caminho do código para automodificação não parece ser o pi-adaptative (falta packages/coding-agent): ${path}`,

	toolProbeRunning: "Rodando o teste das ferramentas...",
	toolRuleRemoved: (mode: string, model: string) => `Regra de reparo de ferramenta ${mode} removida para ${model}.`,
	toolRuleMissing: (mode: string, model: string) => `Nenhuma regra de reparo de ferramenta ${mode} para ${model}.`,
	toolRuleUsage: "Uso: /toolrule-remove <provider/model> <mode>",
	protocolReset: (model: string) => `Calibração do protocolo de ferramentas de texto reiniciada para ${model}.`,
	protocolMissing: (model: string) => `Nenhuma calibração do protocolo de ferramentas de texto para ${model}.`,
	protocolUsage: "Uso: /toolprotocol-reset <provider/model>",
	foregroundBusy: (command: string, interruptKeys: string) =>
		`/${command} só roda com o primeiro plano ocioso. ${interruptKeys} interrompe; seu comando fica no editor.`,
	bashAlreadyRunning: "Um comando bash já está rodando. Aperte Esc para cancelar antes.",

	memorySummariesWaiting: (built: number, needed: number, failed: number) =>
		`aguardando os resumos de memória (${built} de ${needed} folhas prontas${failed > 0 ? `, ${failed} falharam` : ""})`,
	routing: "Roteando",
	turnDone: "Pronto",
	turnFailed: "A resposta falhou",
	retryResumed: "Nova tentativa retomada",
	retryFailedRow: "Nova tentativa falhou",
	waitedFor: (seconds: number) => `depois de ${seconds}s`,
	requestWaiting: (lane: string, provider: string, why: string) => `espera de ${lane}: ${provider} ${why}`,
	waitRateLimited: (resetsIn: string) => `no limite de taxa${resetsIn}`,
	waitOutOfQuota: (resetsIn: string) => `sem cota${resetsIn}`,
	waitResetsIn: (seconds: number) => `, renova em ${seconds}s`,
	emergencyStopEngaged: "parada de emergência ativada",
	waitInFlightLimit: "no limite de requisições em andamento",
	admitted: (provider: string, after: string) => `${provider} admitido ${after}`,
	admittedAtBudget: (provider: string, after: string) => `${provider} admitido no limite de espera ${after}`,
	refusedEmergencyStop: (provider: string, after: string) =>
		`${provider} recusado: parada de emergência ainda ativa ${after}`,
	waitBudgetSpent: (provider: string, after: string) => `${provider} espera esgotada ${after}`,
	waitCancelled: (provider: string, after: string) => `${provider} espera cancelada ${after}`,
	notAdmitted: (provider: string, after: string, cause: string) => `${provider} não admitido ${after}: ${cause}`,
	waitInterrupted: (provider: string, after: string) =>
		`${provider} espera interrompida por uma nova mensagem ${after}`,
	waitClosed: (provider: string, after: string) => `${provider} espera encerrada ${after}`,
} satisfies InterfaceText["interactive"];

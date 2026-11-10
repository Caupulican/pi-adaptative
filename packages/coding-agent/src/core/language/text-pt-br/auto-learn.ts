/**
 * The Brazilian Portuguese words of Auto Learn as the owner reads them: the status block, the notes a settled or
 * re-offered run leaves on the status row, what a launch refused with, the authentication label beside a model in the
 * picker, the footer badge, and the note the model picker adds to an unconfigured model name. The prompts a learner
 * reads, the log lines and the handoff note stay as they are in every language.
 */

import type { InterfaceText } from "../interface-text.ts";

export const AUTO_LEARN = {
	title: "Estado do Auto Learn",
	enabled: (on: boolean) => `Ativado: ${on ? "sim" : "não"}`,
	model: (model: string) => `Modelo: ${model}`,
	nextDecision: (value: string) => `Próxima decisão: ${value}`,
	nextReady: "pronta",
	messages: (count: number, maximum: number) => `Mensagens: ${count}/${maximum}`,
	context: (percent: string, maximum: number) => `Contexto: ${percent}/${maximum}%`,
	cooldown: (value: string) => `Espera: ${value}`,
	cooldownRemaining: (minutes: number) => `${minutes}m restantes`,
	ready: "pronta",
	reflection: (status: string, toolCalls: number) =>
		`Reflexão na sessão atual: ${status} (gatilho de complexidade: ${toolCalls} chamadas de ferramenta; requisições automáticas ao provedor: 0)`,
	historyRetention: "Retenção do histórico: 7 dias para prompts, logs e sessões internos do Auto Learn",
	runningLearners: (count: number, maximum: number) => `Aprendizes rodando: ${count}/${maximum}`,
	otherProjects: (count: number) => `Aprendizes de outros projetos: ${count}`,
	artifactFolder: (dir: string) => `Pasta de artefatos: ${dir}`,
	reloadBlockers: (value: string) => `Bloqueios de recarga automática do Pi: ${value}`,
	reloadBlockerCount: (count: number) => `${count} outra(s) sessão(ões)`,
	inFlight: (count: number) =>
		`Trabalho em curso no portão de recarga: ${count > 0 ? `${count} unidade(s)` : "nenhum"}`,
	runs: "Execuções:",
	noRuns: "- nenhuma",
	runLine: (kind: string, model: string, status: string, logPath: string) =>
		`- aprendiz ${kind} em ${model}, ${status}; log: ${logPath}`,
	runKindReflection: "de reflexão",
	runKindAutomatic: "automático",
	runStatusStarting: "iniciando",
	runStatusRunning: "em execução",
	unknownContext: "desconhecido",
	enabledWord: "ativada",
	disabledWord: "desativada",
	none: "nenhum",
	outcome: {
		reported: "concluído",
		child_failed: "o aprendiz falhou",
		unparseable: "não foi possível ler o resultado",
		learner_not_pass: "o aprendiz não passou",
		parent_session_changed: "a sessão dele mudou antes de terminar",
		apply_failed: "não foi possível aplicar as propostas",
	},
	settled: (outcome: string, detail: string | undefined, applied: number, open: number, persisted: boolean) =>
		`Auto Learn: ${outcome}${detail ? ` (${detail})` : ""}; ${applied} aplicadas, ${open} registradas como achados${persisted ? "" : " (resultado não salvo)"}`,
	reoffered: (outcome: string, applied: number, findings: number) =>
		`Auto Learn: propostas reoferecidas, ${outcome}; ${applied} aplicadas, ${findings} registradas como achados`,
	usageRecordsLost: "Auto Learn: não foi possível recuperar os registros de uso.",
	needsAttention: (count: number) => `Auto Learn: ${count} resultado(s) de aprendizado salvos precisam de atenção.`,
	reofferUnconfirmed: "Auto Learn: não foi possível confirmar um resultado reoferecido.",
	noticePending: "Auto Learn: um aviso foi entregue; algumas cópias salvas ainda esperam limpeza.",
	deferred: (count: number, nearRetention: number) =>
		`Auto Learn: ${count} ${count > 1 ? "conjuntos de propostas não aplicadas estão retidos" : "conjunto de propostas não aplicadas está retido"} para este projeto; eles são oferecidos quando o autoLearn está ativado.${
			nearRetention > 0
				? ` ${nearRetention} ${nearRetention === 1 ? "conjunto adiado está" : "conjuntos adiados estão"} perto ou além da idade normal de retenção; revise antes da limpeza.`
				: ""
		}`,
	notStarted: (reason: string) => `Auto Learn não iniciou: ${reason}`,
	started: (logPath: string) => `Auto Learn iniciou. Log: ${logPath}`,
	reflectionCurrentOnly:
		"a reflexão automática roda só na sessão raiz atual; aprendizes de reflexão em segundo plano estão desativados.",
	noActiveModel: "não há modelo ativo disponível para model=active.",
	cliPathMissing: "não foi possível resolver o caminho atual do CLI do pi.",
	nullByte: (input: string) => `Auto Learn não iniciou: ${input} contém um byte nulo.`,
	promptWriteFailed: (message: string, logPath: string) =>
		`Auto Learn não iniciou: não foi possível gravar o arquivo de prompt (${message}). Log: ${logPath}`,
	accountingUnavailable: (error: string) =>
		`Auto Learn não iniciou: obrigação de contabilidade indisponível (${error}).`,
	spawnFailedWithMessage: (message: string, logPath: string) =>
		`Auto Learn não iniciou: não foi possível iniciar o aprendiz em segundo plano (${message}). Log: ${logPath}`,
	spawnFailed: (logPath: string) =>
		`Auto Learn não iniciou: não foi possível iniciar o aprendiz em segundo plano. Log: ${logPath}`,
	learningBadge: "(aprendendo)",
	current: " · atual",
	auth: {
		subscription: "assinatura",
		apiKey: "chave de API",
		runtime: (label: string) => `runtime ${label}`,
		runtimeApiKey: "chave de API do runtime",
		environment: (label: string) => `env ${label}`,
		environmentApiKey: "chave de API do ambiente",
		modelsJsonKey: "chave de API do models.json",
		modelsJsonCommand: "comando do models.json",
		customConfig: "configuração personalizada do provedor",
		configured: "configurado",
	},
	unverifiedModel: (value: string) =>
		`O modelo do Auto Learn "${value}" não está entre os modelos de assinatura e de API configurados; salvo como manual/não verificado.`,
} satisfies InterfaceText["autoLearn"];

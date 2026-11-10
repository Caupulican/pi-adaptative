/**
 * The Brazilian Portuguese descriptions of the built-in slash commands. Actions are infinitives; command arguments stay
 * exactly as the command takes them, and terms that Brazilian developers keep in English stay in English. Completeness
 * against the command names is a type fact, so a missing or leftover entry does not compile.
 */

import { APP_NAME } from "../../../config.ts";
import type { InterfaceText } from "../interface-text.ts";

export const COMMANDS = {
	settings: "Abrir as configurações",
	secrets: "Guardar e ativar as credenciais do projeto com o Bitwarden",
	autonomy: "Modo de autonomia, diagnósticos, pesquisa e fitness (/autonomy status)",
	status:
		"O que roda sozinho: rotinas, daemon de ausência, eventos do host, rascunhos, avisos, concessões e as ferramentas das execuções recentes",
	plan: "Os planos da sessão: cada plano aberto etapa por etapa, os fechados em uma linha",
	quiz: "Um quiz curto, montado a partir da folha de provas, sobre o resultado recém-concluído",
	proactivity: "Revisão em tempo ocioso que levanta notas: /proactivity [status|on|off|review|prefs <text>]",
	verify: "Obrigações de verificação: /verify [list|show <id>|dismiss <id|all> [note]]",
	memory: "Arquivos de memória gerenciados: /memory drift · knowledge · history · accept <target> · restore <target>",
	knowledge:
		"Conhecimento do dono: /knowledge list [kind|global|project] · show <id> · history <id> · correct <id> <value> · forget <id>",
	taste: "Como você quer o trabalho escrito, conforme aprendido: /taste [<after-id>] · /taste export [path] · /taste proposals · /taste accept <id> · /taste reject <id>",
	edge: "A fronteira (edge): /edge [list] · allow <class> [note] · revoke <class>",
	load: "Carga dos provedores na máquina: requisições em curso, limites registrados, janelas do provedor e parada de emergência",
	estop: "Parada de emergência para novos trabalhos de worker e de segundo plano nesta máquina: /estop [status|on [reason]|off]",
	models: "Ciclo de vida dos modelos locais: /models [list|suggest|add <ref>|remove <ref> confirm|stop]",
	fitness:
		"Escolher e sondar um modelo para papéis locais e de carga pesada, e então atribuí-lo (/fitness [model] [trials])",
	context: "Painel da composição do contexto: o que vai em toda requisição",
	sysprompt: "Editar num painel o system prompt desta sessão: /sysprompt [default|reset]",
	soul: "Editar num painel o arquivo soul do agente: /soul [show|review|history|restore <n>]",
	toolhealth: "Mostrar os diagnósticos de reparo de ferramentas e as regras fixas aprendidas",
	toolprobe: "Sondar o suporte a chamadas de ferramenta nativas e de texto (/toolprobe [provider/model])",
	"toolrule-remove": "Remover uma regra fixa de reparo de ferramentas aprendida (/toolrule-remove <model> <mode>)",
	"toolprotocol-reset":
		"Zerar a calibração do protocolo de ferramentas de texto de um modelo (/toolprotocol-reset <provider/model>)",
	"auto-learn": "Mostrar o estado do Auto Learn e da reflexão, ou rodar agora (/auto-learn run)",
	goal: "Ciclo de vida do objetivo: ver, editar, pausar, retomar, concluir, limpar ou substituir (/goal para ver)",
	"goal-continue": "Continuar explicitamente o ciclo do objetivo atual (/goal-continue [turns] [stalls])",
	task: "Gerenciar as etapas de tarefa da sessão (/task para listar; /task add <text>)",
	steps: "Apelido de /task",
	chat: "Trocar o chat ativo entre a Mente (raiz), um bot persistente ou um time (/chat [root|<bot>|team:<id>])",
	bot: "Gerenciar os bots persistentes e falar direto com eles (/bot [list|new <id> [--write] [model] [soul]|soul <id>|open <id>|msg <id> <text>|stop <id>|retire <id>])",
	lead: "Ver os objetivos entregues aos líderes, e cancelar, pausar ou retomar um (/lead [list|show <leader>|cancel <leader>|pause <leader>|resume <leader>])",
	remote:
		"Conectar máquinas: qualquer máquina pode hospedar (/remote listen, add <name>) ou entrar (/remote join <host:port> <token>); uma máquina conectada aparece como um bot marcado como remoto",
	bots: "Abrir o seletor de chat de bots e times (/bots ou /bot)",
	team: "Gerenciar times de vários bots e falar com eles (/team [list|create <id> <bots> [desc]|members <id> <bots>|open <id>|msg <id> <text>|delete <id>])",
	teams: "Apelido de /team",
	verification:
		"Listar os achados de verificação abertos, ou dispensá-los com um motivo quando só você pode responder (/verification [list|waive <id|all> <reason>])",
	model: "Selecionar o modelo (abre o seletor)",
	thinking: "Selecionar o nível de raciocínio (/thinking [level])",
	fast: "Ligar ou desligar o nível Fast (prioritário) do modelo (/fast [on|off|priority|ultrafast|status])",
	ultrafast: "Ligar ou desligar o nível Ultrafast do modelo (/ultrafast [on|off|status])",
	profiles: "Selecionar um perfil de runtime para esta sessão",
	"scoped-models": "Ativar ou desativar modelos no ciclo do Ctrl+P",
	export: "Exportar a sessão (HTML por padrão, ou informe o caminho: .html/.jsonl)",
	import: "Importar e retomar uma sessão a partir de um arquivo JSONL",
	share: "Compartilhar a sessão como um gist secreto no GitHub",
	copy: "Copiar a última mensagem do agente para a área de transferência",
	name: "Definir o nome de exibição da sessão",
	session: "Mostrar as informações e as estatísticas da sessão",
	cost: "Mostrar a composição do custo da sessão",
	usage: "Uso e limites: sessão, hoje, máquina e cada conta conectada (/usage reset resgata um reset conquistado)",
	changelog: "Mostrar as entradas do changelog",
	hotkeys: "Mostrar todos os atalhos de teclado",
	fork: "Criar um novo fork a partir de uma mensagem anterior do usuário (nome opcional: /fork <name>)",
	clone: "Duplicar a sessão atual na posição atual (nome opcional: /clone <name>)",
	tree: "Navegar pela árvore de sessões (trocar de branch)",
	trust: "Marcar ou desmarcar esta pasta do projeto como confiável",
	login: "Configurar a autenticação do provedor",
	logout: "Remover a autenticação do provedor",
	new: "Iniciar uma nova sessão (nome opcional: /new <name>)",
	compact: "Compactar o contexto da sessão manualmente",
	"self-compact-info":
		"Mostrar o uso da autocompactação, linhas, fase, ciclos, prompts e qualquer nota salva (sem turno do modelo)",
	"self-compact-now":
		"Compactar agora: reaproveitar uma nota de autocompactação salva, ou pedir ao agente que escreva uma",
	curate: "Revisar ou arquivar skills promovidas pela reflexão que estão paradas ou se sobrepõem",
	resume: "Retomar outra sessão",
	reload: "Recarregar atalhos, extensões, skills, prompts e temas",
	"install-resources":
		"Copiar recursos de uma pasta confiável para as configurações locais do usuário (/install-resources <dir> [--force])",
	"config-backup": "Salvar perfis e configurações de recursos num arquivo JSON (/config-backup [file])",
	"config-restore": "Restaurar perfis e configurações de recursos de um arquivo JSON (/config-restore <file>)",
	exit: `Sair do ${APP_NAME}`,
	quit: `Sair do ${APP_NAME}`,
} satisfies InterfaceText["commands"];

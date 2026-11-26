/*
 * =============================================================================
 *  BACKEND DA SEPARADORA N1
 * =============================================================================
 *
 *  O QUE ESTE ARQUIVO FAZ
 *  É a "ponte" entre o CLP e a tela no navegador:
 *
 *    CLP S7-1500 (PLCSIM Advanced) --OPC UA--> ESTE BACKEND --Socket.IO--> navegador (Vue)
 *
 *  1. Conecta no servidor OPC UA do CLP.
 *  2. Lê os contadores de peças e o estado da máquina a cada 500 ms.
 *  3. Envia esses valores para a tela (Vue) em tempo real, por Socket.IO.
 *  4. Também mostra os valores em JSON no endereço http://localhost:3000.
 *  5. Se a comunicação cair, avisa a tela e tenta reconectar sozinho.
 *
 *  QUEM É CLIENTE E QUEM É SERVIDOR
 *  - No OPC UA, o CLP é o SERVIDOR: ele FORNECE os dados.
 *  - No OPC UA, este backend é o CLIENTE: ele CONSOME os dados
 *    (abre a conexão, cria a sessão e pede os valores).
 *  - Para o navegador, este backend é o SERVIDOR (HTTP e Socket.IO na porta 3000).
 *
 *  POR QUE O BACKEND É CLIENTE OPC UA
 *  1. Os dados estão no CLP, que é quem os serve; o backend é quem os pede.
 *  2. O navegador não fala o protocolo OPC UA (opc.tcp). O backend lê do CLP e
 *     repassa os valores em formatos que o navegador entende (JSON e Socket.IO).
 *  3. Os navegadores não se conectam ao CLP: só o backend abre sessão OPC UA.
 *  4. O backend só LÊ: nada neste código escreve no CLP.
 *
 *  ORDEM EM QUE AS COISAS ACONTECEM
 *  listen() -> conectar() -> ler() a cada 500 ms -> se der erro: falha() -> espera 3 s -> conectar()
 * =============================================================================
 */


/* -----------------------------------------------------------------------------
 *  1. BIBLIOTECAS (instaladas com "npm install", listadas no package.json)
 * -------------------------------------------------------------------------- */

// express: cria o servidor web e as rotas (aqui, a rota GET "/" que devolve o JSON).
const express = require('express')

// cors: libera que páginas de outro endereço/porta acessem este backend.
// Sem isso, o navegador bloquearia as requisições vindas de outra origem.
const cors = require('cors')

// http: módulo nativo do Node.js. Cria o servidor HTTP que o express e o
// Socket.IO vão compartilhar na mesma porta.
const http = require('node:http')

// socket.io: comunicação em tempo real. O backend "empurra" os dados para o
// navegador sempre que lê valores novos, sem a página precisar recarregar.
const { Server } = require('socket.io')

// node-opcua: biblioteca que implementa o protocolo OPC UA em Node.js.
//  - OPCUAClient: o cliente que conecta no servidor OPC UA do CLP.
//  - MessageSecurityMode / SecurityPolicy: configurações de segurança da conexão.
//  - AttributeIds: diz QUAL atributo do nó queremos ler (aqui, sempre o Value = valor).
const {
  OPCUAClient,
  MessageSecurityMode,
  SecurityPolicy,
  AttributeIds
} = require('node-opcua')


/* -----------------------------------------------------------------------------
 *  2. CONFIGURAÇÕES DO OPC UA
 * -------------------------------------------------------------------------- */

// ENDPOINT: endereço de rede do servidor OPC UA, no formato opc.tcp://<IP>:<porta>.
// É o "ponto de entrada" onde o cliente se conecta. 4840 é a porta padrão do OPC UA.
// Ajuste o IP conforme a instância do PLCSIM Advanced.
const ENDPOINT = 'opc.tcp://169.254.171.199:4840'

// NAMESPACE: "espaço de nomes" que agrupa as variáveis de uma mesma origem.
// O servidor guarda uma lista de URIs (o NamespaceArray) e cada variável usa a
// POSIÇÃO (índice) da sua URI nessa lista, que é o "ns=" do NodeId.
// A URI abaixo precisa ser a mesma configurada no servidor OPC UA do CLP.
// O índice NÃO fica fixo aqui: ele é descoberto quando o backend conecta.
const URI_NAMESPACE = 'http://vue'

// NODEID: "endereço" de cada variável dentro do servidor OPC UA, no formato
//   ns=<índice do namespace>;i=<identificador numérico>
// Aqui ficam só os identificadores (o "i="). Eles precisam ser os mesmos
// identificadores dessas variáveis no servidor OPC UA do CLP.
// O nome à esquerda é o nome usado no JSON e enviado para a tela.
const IDS = {
  contPecasVermelhas: 3,
  contPecasVerdes: 4,
  contPecasAmarelas: 5,
  contPecasTotal: 6,
  estadoMaquina: 7
}


/* -----------------------------------------------------------------------------
 *  3. CONFIGURAÇÕES GERAIS (tempos em milissegundos: 1000 ms = 1 s)
 * -------------------------------------------------------------------------- */

const PORTA_HTTP = 3000            // porta do backend (JSON e Socket.IO)
const INTERVALO_LEITURA_MS = 500   // de quanto em quanto tempo lê o CLP
const ESPERA_RECONEXAO_MS = 3000   // quanto espera antes de tentar reconectar
const TEMPO_LIMITE_MS = 3000       // quanto espera uma resposta do CLP antes de desistir


/* -----------------------------------------------------------------------------
 *  4. CRIAÇÃO DOS SERVIDORES HTTP E SOCKET.IO
 * -------------------------------------------------------------------------- */

const app = express()                         // aplicação express (rotas HTTP)
app.use(cors())                               // libera acesso de outras origens
const servidorHttp = http.createServer(app)   // servidor HTTP usando o express

// Servidor Socket.IO "pendurado" no mesmo servidor HTTP (mesma porta 3000).
// origin: '*' permite que qualquer página se conecte ao Socket.IO.
const io = new Server(servidorHttp, { cors: { origin: '*' } })


/* -----------------------------------------------------------------------------
 *  5. ESTADO DO PROGRAMA (variáveis que mudam enquanto o backend roda)
 * -------------------------------------------------------------------------- */

// Situação da comunicação OPC UA. É isso que aparece no JSON e na tela.
const opc = {
  conectado: false,                        // true = lendo o CLP normalmente
  mensagem: `Conectando a ${ENDPOINT}`,    // texto explicando a situação atual
  ultimaLeitura: null                      // data/hora da última leitura que deu certo
}

// Últimos valores lidos do CLP. Começa tudo em 0:
// { contPecasVermelhas: 0, contPecasVerdes: 0, ..., estadoMaquina: 0 }
const dados = Object.fromEntries(Object.keys(IDS).map(nome => [nome, 0]))

let cliente = null          // o cliente OPC UA (a conexão com o CLP)
let sessao = null           // a sessão OPC UA aberta (é por ela que se lê os valores)
let nos = []                // lista das variáveis a ler, já com o NodeId completo
let timerLeitura = null     // o "relógio" que chama ler() a cada 500 ms
let lendo = false           // trava: impede começar uma leitura antes da anterior terminar
let reconectando = false    // trava: impede abrir duas reconexões ao mesmo tempo
let tentativas = 0          // quantas tentativas de conexão seguidas sem sucesso


/* -----------------------------------------------------------------------------
 *  6. FUNÇÕES AUXILIARES
 * -------------------------------------------------------------------------- */

// Transforma as mensagens de erro técnicas em um texto curto e legível.
// Erros de rede (servidor desligado, recusou, não respondeu...) viram:
// "o servidor OPC UA não respondeu em opc.tcp://..."
// Qualquer outro erro: usa só a primeira linha da mensagem.
function resumirErro(texto) {
  const mensagem = String(texto ?? 'erro desconhecido')
  if (/cannot be established|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|sem resposta/i.test(mensagem)) {
    return `o servidor OPC UA não respondeu em ${ENDPOINT}`
  }
  return mensagem.split('\n')[0]
}

// Coloca um tempo limite em qualquer operação com o CLP.
// Funciona como uma "corrida": o que terminar primeiro ganha.
//  - se o CLP responder antes de "ms", devolve a resposta normalmente;
//  - se o tempo acabar antes, dá o erro "sem resposta em X ms".
// Assim o backend nunca fica travado esperando um CLP que não responde.
function comTempoLimite(promessa, ms) {
  promessa.catch(() => {})   // evita aviso de erro "solto" se a operação falhar depois do tempo limite
  let timer
  const limite = new Promise((_, rejeitar) => {
    timer = setTimeout(() => rejeitar(new Error(`sem resposta em ${ms} ms`)), ms)
  })
  return Promise.race([promessa, limite]).finally(() => clearTimeout(timer))
}

// Atualiza a situação da comunicação (conectado ou não + mensagem).
// Só avisa quando algo MUDOU, para não repetir a mesma mensagem a cada 500 ms.
// Quando muda: escreve no terminal e avisa todas as telas abertas pelo Socket.IO.
function definirStatus(conectado, mensagem) {
  const mudou = opc.conectado !== conectado || opc.mensagem !== mensagem
  opc.conectado = conectado
  opc.mensagem = mensagem
  if (!mudou) return

  console.log(`[OPC UA] ${conectado ? 'CONECTADO' : 'DESCONECTADO'} - ${mensagem}`)
  io.emit('opcStatus', conectado)   // evento simples: true ou false
  io.emit('opcInfo', opc)           // evento completo: conectado, mensagem e última leitura
}


/* -----------------------------------------------------------------------------
 *  7. CONEXÃO COM O CLP (cliente OPC UA)
 * -------------------------------------------------------------------------- */

// Conecta no servidor OPC UA do CLP, descobre os NodeIds e começa as leituras.
// Se qualquer passo der errado, vai para falha(), que agenda uma nova tentativa.
async function conectar() {
  // Na primeira tentativa, mostra "Conectando a ...".
  // Nas seguintes, mantém a mensagem de erro que explica por que caiu.
  if (tentativas === 0) definirStatus(false, `Conectando a ${ENDPOINT}`)
  tentativas++

  try {
    // PASSO 1: criar o cliente OPC UA.
    //  - securityMode/securityPolicy None: conexão SEM criptografia e SEM assinatura.
    //    Por isso o servidor OPC UA do CLP precisa aceitar conexões sem segurança.
    //  - endpointMustExist: false: não exige que o endereço usado aqui seja
    //    exatamente igual ao que o servidor anuncia na lista de endpoints dele.
    //  - maxRetry: 0: a biblioteca não fica tentando reconectar sozinha;
    //    quem controla as novas tentativas é a função falha() deste arquivo.
    cliente = OPCUAClient.create({
      applicationName: 'Backend Planta N1',
      endpointMustExist: false,
      securityMode: MessageSecurityMode.None,
      securityPolicy: SecurityPolicy.None,
      connectionStrategy: { initialDelay: 500, maxDelay: 1000, maxRetry: 0 }
    })

    // Se a biblioteca perceber que a conexão caiu, chama falha().
    cliente.on('connection_lost', () => falha('conexão com o S7-1500 perdida'))

    // PASSO 2: conectar no endpoint (abre a comunicação de rede com o CLP).
    await comTempoLimite(cliente.connect(ENDPOINT), TEMPO_LIMITE_MS)

    // PASSO 3: criar a sessão. createSession() sem usuário e senha = sessão ANÔNIMA,
    // por isso o servidor OPC UA do CLP também precisa aceitar acesso anônimo.
    sessao = await comTempoLimite(cliente.createSession(), TEMPO_LIMITE_MS)

    // PASSO 4: descobrir o índice do namespace (o "ns=").
    // ns=0;i=2255 é o NodeId padrão do NamespaceArray, que existe em todo
    // servidor OPC UA. Ele devolve a lista de URIs, por exemplo:
    //   [ 'http://opcfoundation.org/UA/', ..., 'http://vue', ... ]
    const respostaNamespace = await comTempoLimite(
      sessao.read({ nodeId: 'ns=0;i=2255', attributeId: AttributeIds.Value }),
      TEMPO_LIMITE_MS
    )
    if (!respostaNamespace.statusCode.isGood()) {
      throw new Error('não foi possível ler o NamespaceArray do servidor OPC UA')
    }

    // Procura 'http://vue' na lista. A posição onde ela está é o índice do namespace.
    // Se não encontrar (-1), a URI configurada no CLP é diferente da deste código.
    const indiceNamespace = respostaNamespace.value.value.indexOf(URI_NAMESPACE)
    if (indiceNamespace < 0) {
      throw new Error(`namespace ${URI_NAMESPACE} não encontrado. Confira a server interface no TIA.`)
    }

    // PASSO 5: montar o NodeId completo de cada variável juntando o índice
    // descoberto com o identificador da lista IDS. Exemplo: ns=<índice>;i=3
    nos = Object.entries(IDS).map(([nome, id]) => ({
      nome,
      nodeId: `ns=${indiceNamespace};i=${id}`,
      attributeId: AttributeIds.Value   // queremos ler o VALOR da variável
    }))

    // Mostra no terminal os NodeIds montados (útil para comparar com o TIA).
    console.log('[OPC UA] NodeIds lidos:')
    nos.forEach(no => console.log(`   ${no.nome.padEnd(20)} ${no.nodeId}`))

    // PASSO 6: faz a primeira leitura e, se ainda houver sessão (ou seja, a
    // leitura não falhou), liga o "relógio" que chama ler() a cada 500 ms.
    await ler()
    if (sessao) timerLeitura = setInterval(ler, INTERVALO_LEITURA_MS)
  } catch (erro) {
    // Qualquer erro nos passos acima: registra e agenda nova tentativa.
    await falha(erro.message)
  }
}


/* -----------------------------------------------------------------------------
 *  8. LEITURA DOS VALORES (executada a cada 500 ms)
 * -------------------------------------------------------------------------- */

async function ler() {
  // Não lê se ainda houver uma leitura em andamento ou se não houver sessão.
  if (lendo || !sessao) return
  lendo = true

  try {
    // Lê TODAS as variáveis de uma vez, em uma única requisição ao CLP.
    const valores = await comTempoLimite(sessao.read(nos), TEMPO_LIMITE_MS)

    // Cada valor vem com um statusCode. "Good" = leitura válida.
    // Se algum vier ruim (ex.: NodeId que não existe), gera um erro dizendo qual.
    const indiceInvalido = valores.findIndex(valor => !valor.statusCode.isGood())
    if (indiceInvalido >= 0) {
      throw new Error(
        `leitura inválida em ${nos[indiceInvalido].nome} (${nos[indiceInvalido].nodeId}): ` +
        `${valores[indiceInvalido].statusCode.name}. Confira os identificadores no TIA.`
      )
    }

    // Converte cada valor para número e monta um objeto { nome: valor }.
    // Se algum não for um número válido, gera erro.
    const novosDados = Object.fromEntries(nos.map((no, indice) => {
      const valor = Number(valores[indice].value.value)
      if (!Number.isFinite(valor)) throw new Error(`valor inválido em ${no.nome}`)
      return [no.nome, valor]
    }))

    // Só chega aqui se TODOS os valores forem válidos: aí atualiza "dados".
    Object.assign(dados, novosDados)

    // Registra a hora da leitura, zera as tentativas e marca como conectado.
    opc.ultimaLeitura = new Date().toISOString()
    tentativas = 0
    definirStatus(true, 'Comunicação com o S7-1500 ativa')

    // Envia os valores para todas as telas abertas (evento 'dadosProducao').
    // É isso que faz os indicadores do Vue mudarem sem recarregar a página.
    io.emit('dadosProducao', { ...dados, ultimaLeitura: opc.ultimaLeitura })
  } catch (erro) {
    await falha(erro.message)
  } finally {
    // Libera a trava para a próxima leitura (com ou sem erro).
    lendo = false
  }
}


/* -----------------------------------------------------------------------------
 *  9. TRATAMENTO DE FALHA E RECONEXÃO
 * -------------------------------------------------------------------------- */

// Chamada sempre que algo dá errado: CLP não responde, conexão cai,
// NodeId errado, namespace não encontrado etc.
// O que ela faz:
//  1. para as leituras;
//  2. marca como DESCONECTADO (aparece no terminal, no JSON e na tela);
//  3. fecha a sessão e a conexão antigas;
//  4. espera 3 s e chama conectar() de novo.
// Durante a falha, "dados" mantém os últimos valores lidos. O backend não
// escreve no CLP; ao reconectar, volta a ler os valores atuais do CLP.
async function falha(motivo) {
  // Se já existe uma reconexão em andamento, não abre outra.
  if (reconectando) return
  reconectando = true

  // 1. Para o "relógio" de leituras.
  clearInterval(timerLeitura)
  timerLeitura = null

  // 2. Avisa que caiu, com o motivo resumido.
  definirStatus(false, `Sem comunicação: ${resumirErro(motivo)}. Tentando reconectar.`)

  // 3. Guarda a sessão/cliente antigos e limpa as variáveis globais.
  const clienteAnterior = cliente
  const sessaoAnterior = sessao
  cliente = null
  sessao = null

  // Fecha a sessão e desconecta (no máximo 1 s cada). Se der erro ao fechar,
  // ignora, porque a conexão provavelmente já estava caída.
  try {
    if (sessaoAnterior) await comTempoLimite(sessaoAnterior.close(), 1000)
  } catch (_) {}
  try {
    if (clienteAnterior) await comTempoLimite(clienteAnterior.disconnect(), 1000)
  } catch (_) {}

  // 4. Depois de 3 s, libera a trava e tenta conectar de novo.
  setTimeout(() => {
    reconectando = false
    conectar()
  }, ESPERA_RECONEXAO_MS)
}


/* -----------------------------------------------------------------------------
 *  10. ROTA HTTP: JSON DE CONFERÊNCIA
 * -------------------------------------------------------------------------- */

// Acessando http://localhost:3000 no navegador, aparece este JSON com a situação
// da comunicação OPC UA e os últimos valores lidos do CLP.
app.get('/', (req, res) => {
  res.json({
    backend: 'Funcionando',
    opcUa: opc.conectado ? 'Conectado' : 'Desconectado',
    mensagem: opc.mensagem,
    ultimaLeitura: opc.ultimaLeitura,
    producao: dados
  })
})


/* -----------------------------------------------------------------------------
 *  11. SOCKET.IO: QUANDO UMA TELA SE CONECTA
 * -------------------------------------------------------------------------- */

// Quando uma tela (Vue) se conecta, ela recebe na hora a situação atual e os
// últimos valores, sem esperar a próxima leitura. Depois disso, ela continua
// recebendo 'dadosProducao' a cada leitura e 'opcStatus'/'opcInfo' quando a
// situação da conexão muda (enviados pelas funções ler() e definirStatus()).
io.on('connection', socket => {
  socket.emit('opcStatus', opc.conectado)
  socket.emit('opcInfo', opc)
  socket.emit('dadosProducao', { ...dados, ultimaLeitura: opc.ultimaLeitura })
})


/* -----------------------------------------------------------------------------
 *  12. PROTEÇÃO E INICIALIZAÇÃO
 * -------------------------------------------------------------------------- */

// Se alguma promessa falhar sem tratamento, apenas registra um aviso no
// terminal em vez de derrubar o backend.
process.on('unhandledRejection', erro => console.log('[aviso]', erro?.message ?? erro))

// Liga o servidor na porta 3000 e, assim que estiver no ar, inicia a conexão com o CLP.
servidorHttp.listen(PORTA_HTTP, () => {
  console.log(`Backend em http://localhost:${PORTA_HTTP}`)
  conectar()
})

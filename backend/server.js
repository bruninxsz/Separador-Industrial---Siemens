const express = require('express')
const cors = require('cors')
const http = require('node:http')
const { Server } = require('socket.io')
const {
  OPCUAClient,
  MessageSecurityMode,
  SecurityPolicy,
  AttributeIds
} = require('node-opcua')

// Ajuste o IP conforme a instância do PLCSIM Advanced.
const ENDPOINT = 'opc.tcp://169.254.171.199:4840'
const URI_NAMESPACE = 'http://vue'
const IDS = {
  contPecasVermelhas: 3,
  contPecasVerdes: 4,
  contPecasAmarelas: 5,
  contPecasTotal: 6,
  estadoMaquina: 7
}

const PORTA_HTTP = 3000
const INTERVALO_LEITURA_MS = 500
const ESPERA_RECONEXAO_MS = 3000
const TEMPO_LIMITE_MS = 3000

const app = express()
app.use(cors())
const servidorHttp = http.createServer(app)
const io = new Server(servidorHttp, { cors: { origin: '*' } })

const opc = {
  conectado: false,
  mensagem: `Conectando a ${ENDPOINT}`,
  ultimaLeitura: null
}
const dados = Object.fromEntries(Object.keys(IDS).map(nome => [nome, 0]))

let cliente = null
let sessao = null
let nos = []
let timerLeitura = null
let lendo = false
let reconectando = false
let tentativas = 0

function resumirErro(texto) {
  const mensagem = String(texto ?? 'erro desconhecido')
  if (/cannot be established|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|sem resposta/i.test(mensagem)) {
    return `o servidor OPC UA não respondeu em ${ENDPOINT}`
  }
  return mensagem.split('\n')[0]
}

function comTempoLimite(promessa, ms) {
  promessa.catch(() => {})
  let timer
  const limite = new Promise((_, rejeitar) => {
    timer = setTimeout(() => rejeitar(new Error(`sem resposta em ${ms} ms`)), ms)
  })
  return Promise.race([promessa, limite]).finally(() => clearTimeout(timer))
}

function definirStatus(conectado, mensagem) {
  const mudou = opc.conectado !== conectado || opc.mensagem !== mensagem
  opc.conectado = conectado
  opc.mensagem = mensagem
  if (!mudou) return

  console.log(`[OPC UA] ${conectado ? 'CONECTADO' : 'DESCONECTADO'} - ${mensagem}`)
  io.emit('opcStatus', conectado)
  io.emit('opcInfo', opc)
}

async function conectar() {
  if (tentativas === 0) definirStatus(false, `Conectando a ${ENDPOINT}`)
  tentativas++

  try {
    cliente = OPCUAClient.create({
      applicationName: 'Backend Planta N1',
      endpointMustExist: false,
      securityMode: MessageSecurityMode.None,
      securityPolicy: SecurityPolicy.None,
      connectionStrategy: { initialDelay: 500, maxDelay: 1000, maxRetry: 0 }
    })
    cliente.on('connection_lost', () => falha('conexão com o S7-1500 perdida'))

    await comTempoLimite(cliente.connect(ENDPOINT), TEMPO_LIMITE_MS)
    sessao = await comTempoLimite(cliente.createSession(), TEMPO_LIMITE_MS)

    const respostaNamespace = await comTempoLimite(
      sessao.read({ nodeId: 'ns=0;i=2255', attributeId: AttributeIds.Value }),
      TEMPO_LIMITE_MS
    )
    if (!respostaNamespace.statusCode.isGood()) {
      throw new Error('não foi possível ler o NamespaceArray do servidor OPC UA')
    }

    const indiceNamespace = respostaNamespace.value.value.indexOf(URI_NAMESPACE)
    if (indiceNamespace < 0) {
      throw new Error(`namespace ${URI_NAMESPACE} não encontrado. Confira a server interface no TIA.`)
    }

    nos = Object.entries(IDS).map(([nome, id]) => ({
      nome,
      nodeId: `ns=${indiceNamespace};i=${id}`,
      attributeId: AttributeIds.Value
    }))
    console.log('[OPC UA] NodeIds lidos:')
    nos.forEach(no => console.log(`   ${no.nome.padEnd(20)} ${no.nodeId}`))

    await ler()
    if (sessao) timerLeitura = setInterval(ler, INTERVALO_LEITURA_MS)
  } catch (erro) {
    await falha(erro.message)
  }
}

async function ler() {
  if (lendo || !sessao) return
  lendo = true

  try {
    const valores = await comTempoLimite(sessao.read(nos), TEMPO_LIMITE_MS)
    const indiceInvalido = valores.findIndex(valor => !valor.statusCode.isGood())
    if (indiceInvalido >= 0) {
      throw new Error(
        `leitura inválida em ${nos[indiceInvalido].nome} (${nos[indiceInvalido].nodeId}): ` +
        `${valores[indiceInvalido].statusCode.name}. Confira os identificadores no TIA.`
      )
    }

    const novosDados = Object.fromEntries(nos.map((no, indice) => {
      const valor = Number(valores[indice].value.value)
      if (!Number.isFinite(valor)) throw new Error(`valor inválido em ${no.nome}`)
      return [no.nome, valor]
    }))
    Object.assign(dados, novosDados)

    opc.ultimaLeitura = new Date().toISOString()
    tentativas = 0
    definirStatus(true, 'Comunicação com o S7-1500 ativa')
    io.emit('dadosProducao', { ...dados, ultimaLeitura: opc.ultimaLeitura })
  } catch (erro) {
    await falha(erro.message)
  } finally {
    lendo = false
  }
}

async function falha(motivo) {
  if (reconectando) return
  reconectando = true

  clearInterval(timerLeitura)
  timerLeitura = null
  definirStatus(false, `Sem comunicação: ${resumirErro(motivo)}. Tentando reconectar.`)

  const clienteAnterior = cliente
  const sessaoAnterior = sessao
  cliente = null
  sessao = null

  try {
    if (sessaoAnterior) await comTempoLimite(sessaoAnterior.close(), 1000)
  } catch (_) {}
  try {
    if (clienteAnterior) await comTempoLimite(clienteAnterior.disconnect(), 1000)
  } catch (_) {}

  setTimeout(() => {
    reconectando = false
    conectar()
  }, ESPERA_RECONEXAO_MS)
}

app.get('/', (req, res) => {
  res.json({
    backend: 'Funcionando',
    opcUa: opc.conectado ? 'Conectado' : 'Desconectado',
    mensagem: opc.mensagem,
    ultimaLeitura: opc.ultimaLeitura,
    producao: dados
  })
})

io.on('connection', socket => {
  socket.emit('opcStatus', opc.conectado)
  socket.emit('opcInfo', opc)
  socket.emit('dadosProducao', { ...dados, ultimaLeitura: opc.ultimaLeitura })
})

process.on('unhandledRejection', erro => console.log('[aviso]', erro?.message ?? erro))

servidorHttp.listen(PORTA_HTTP, () => {
  console.log(`Backend em http://localhost:${PORTA_HTTP}`)
  conectar()
})
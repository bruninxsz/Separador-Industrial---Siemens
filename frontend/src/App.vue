<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { io } from 'socket.io-client'

const indicadores = [
  { titulo: 'Produção total', descricao: 'Total de peças processadas', chave: 'total', cor: 'teal' },
  { titulo: 'Metais', descricao: 'Quantidade de materiais metálicos', chave: 'metais', cor: 'red' },
  { titulo: 'Plásticos', descricao: 'Quantidade de materiais plásticos', chave: 'plasticos', cor: 'green' },
  { titulo: 'Vidros', descricao: 'Quantidade de materiais de vidro', chave: 'vidros', cor: 'yellow' },
]

const cores = {
  teal: 'border-[#1596a8]',
  red: 'border-[#ce292b]',
  green: 'border-[#31833b]',
  yellow: 'border-[#ffad24]',
}

const plc = ref({
  connected: false,
  message: 'Conectando ao backend...',
  updatedAt: null,
  counters: { metais: 0, plasticos: 0, vidros: 0, total: 0 },
  state: 0,
})
const statusClass = computed(() => plc.value.connected
  ? 'border-[#31833b] bg-[#286d32]'
  : 'border-[#ee655e] bg-[#a9322d]')
const statusLabel = computed(() => plc.value.connected
  ? 'PLC conectado'
  : 'PLC desconectado')
const updatedLabel = computed(() => plc.value.updatedAt
  ? new Date(plc.value.updatedAt).toLocaleTimeString('pt-BR')
  : 'Sem leitura')

onMounted(() => {
  socket = io()
  socket.on('opcStatus', (connected) => {
    plc.value.connected = connected
  })
  socket.on('opcInfo', (info) => {
    plc.value.connected = info.conectado
    plc.value.message = info.mensagem
    plc.value.updatedAt = info.ultimaLeitura
  })
  socket.on('dadosProducao', (data) => {
    plc.value.counters = {
      metais: data.contMetais,
      plasticos: data.contPlasticos,
      vidros: data.contVidros,
      total: data.contPecasTotal,
    }
    plc.value.state = data.estadoMaquina
    plc.value.updatedAt = data.ultimaLeitura
  })
  socket.on('disconnect', () => {
    plc.value.connected = false
    plc.value.message = 'Conexão com o backend interrompida. Reconectando...'
  })
  socket.on('connect_error', () => {
    plc.value.connected = false
    plc.value.message = 'Backend indisponível. Tentando reconectar...'
  })
})

let socket
onUnmounted(() => socket?.disconnect())
</script>

<template>
  <main class="min-h-screen bg-[#e9eef2] font-sans text-[#203a4e]">
    <header class="flex min-h-[104px] flex-col items-start justify-between gap-4 border-b-[5px] border-[#209b72] bg-[#203a4e] px-[3.6%] py-5 text-white sm:flex-row sm:items-center sm:gap-6">
      <div>
        <h1 class="m-0 text-2xl font-medium leading-tight">Interface Gráfica da Planta N1</h1>
        <p class="mt-2.5 text-sm text-[#d2dce3]">Separação e contagem de materiais</p>
      </div>
      <div class="inline-flex shrink-0 items-center gap-2 rounded-[5px] border px-3.5 py-[11px] text-[13px] font-bold" :class="statusClass" role="status" aria-live="polite">
        <span class="size-2.5 rounded-full bg-white"></span>
        {{ statusLabel }}
      </div>
    </header>

    <div class="mx-auto my-6 w-[calc(100%-28px)] max-w-[1120px] sm:my-[25px] sm:w-[calc(100%-44px)]">
      <section class="mt-0 rounded-md border border-[#cbd5dc] bg-white px-5 py-[23px] shadow-[0_2px_5px_rgba(24,45,61,0.14)]" aria-labelledby="production-title">
        <h2 id="production-title" class="mb-6 text-xl font-normal leading-snug">Indicadores de produção</h2>
        <div class="grid grid-cols-1 gap-3 min-[381px]:grid-cols-2 sm:gap-5 lg:grid-cols-4">
          <article v-for="item in indicadores" :key="item.cor" class="flex min-h-[229px] flex-col items-center rounded-md border border-[#d7e0e6] bg-[#f7f9fa] px-2.5 pb-3.5 pt-[17px] text-center">
            <div class="grid size-[124px] shrink-0 place-items-center rounded-full border-[15px] bg-white" :class="cores[item.cor]">
              <span class="text-[30px] font-bold text-[#1c3447]">{{ plc.counters[item.chave] ?? '—' }}</span>
            </div>
            <h3 class="mb-[7px] mt-4 text-sm font-bold leading-tight text-[#263d50]">{{ item.titulo }}</h3>
            <p class="m-0 max-w-[150px] text-xs leading-tight text-[#647d8d]">{{ item.descricao }}</p>
          </article>
        </div>
        <table class="mt-6 w-full border-collapse text-left" aria-label="Contagem de materiais separados">
          <thead>
            <tr class="border-b border-[#cbd5dc] text-sm text-[#526b7b]">
              <th class="px-3 py-2 font-semibold">Material</th>
              <th class="px-3 py-2 text-right font-semibold">Quantidade</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="linha in [
              { nome: 'Metal', chave: 'metais' },
              { nome: 'Plástico', chave: 'plasticos' },
              { nome: 'Vidro', chave: 'vidros' },
              { nome: 'Total', chave: 'total' },
            ]" :key="linha.chave" class="border-b border-[#e2e8ec] last:border-0">
              <th scope="row" class="px-3 py-3 font-medium">{{ linha.nome }}</th>
              <td class="px-3 py-3 text-right font-bold tabular-nums">{{ plc.counters[linha.chave] ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <div class="mt-[17px] grid grid-cols-1 gap-4 sm:grid-cols-2">
        <section class="min-h-[182px] rounded-md border border-[#cbd5dc] bg-white px-5 py-[21px] shadow-[0_2px_5px_rgba(24,45,61,0.14)]" aria-labelledby="state-title">
          <h2 id="state-title" class="text-xl font-normal leading-snug">Estado da aplicação</h2>
          <div class="mt-6 text-[40px] font-bold leading-none text-[#209b72]">{{ plc.state ?? '—' }}</div>
          <p class="mt-[26px] text-sm text-[#354c5d]">Estado atual da máquina de estados</p>
        </section>

        <section class="min-h-[182px] rounded-md border border-[#cbd5dc] bg-white px-5 py-[21px] shadow-[0_2px_5px_rgba(24,45,61,0.14)]" aria-labelledby="opc-title">
          <h2 id="opc-title" class="text-xl font-normal leading-snug">Comunicação OPC UA</h2>
          <p class="mt-5 text-base text-[#526b7b]">{{ plc.message }}</p>
          <p class="mt-3 text-xs text-[#647d8d]">Última leitura: {{ updatedLabel }}</p>
        </section>
      </div>
    </div>
  </main>
</template>

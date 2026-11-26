# Separadora N1 – Backend e interface web

Este repositório contém a parte de software da integração da Separadora N1:

- **`backend/`**: servidor Node.js que lê os dados de produção do CLP S7-1500 via **OPC UA** e os entrega em JSON (HTTP) e em tempo real (**Socket.IO**).
- **`frontend/`**: interface **Vue** que recebe esses dados por Socket.IO e mostra os indicadores de produção e o status da comunicação.

O projeto TIA Portal e o gêmeo digital **não estão neste repositório**.

---

## 1. Fluxo de dados

```
CLP S7-1500 (PLCSIM Advanced)  --OPC UA (porta 4840)-->  backend Node.js  --Socket.IO (porta 3000)-->  interface Vue
      servidor OPC UA                                     cliente OPC UA                                 (navegador)
                                                          servidor HTTP + Socket.IO
```

- O **CLP** é o **servidor OPC UA**: ele fornece os dados.
- O **backend** é o **cliente OPC UA**: ele abre a sessão com o CLP e lê os valores. Para a interface, o backend é **servidor** (HTTP e Socket.IO).
- A **interface Vue** consome os dados do backend por Socket.IO.

O backend só lê os valores. Nenhuma parte deste repositório escreve no CLP.

---

## 2. Dependências

| Pasta | Pacotes (de `package.json`) |
|---|---|
| `backend/` | `express`, `cors`, `socket.io`, `node-opcua`. Em desenvolvimento: `nodemon` |
| `frontend/` | `vue`, `socket.io-client`, `tailwindcss`, `@tailwindcss/vite`. Em desenvolvimento: `vite`, `@vitejs/plugin-vue` |

Ambiente onde o backend foi executado: Node.js v24.14.0 e npm 11.9.0.

Para instalar e conferir:

```bash
cd backend
npm install
npm ls express cors socket.io node-opcua

cd ../frontend
npm install
npm ls socket.io-client
```

---

## 3. O que o backend exige do CLP

Estes valores estão fixos em [backend/server.js](backend/server.js). O servidor OPC UA configurado no TIA Portal precisa corresponder a eles:

| Item | Valor no código | Onde alterar |
|---|---|---|
| Endpoint OPC UA | `opc.tcp://169.254.171.199:4840` | constante `ENDPOINT` |
| URI do namespace | `http://vue` | constante `URI_NAMESPACE` |
| Segurança | `MessageSecurityMode.None` e `SecurityPolicy.None`, sessão sem usuário (anônima) | `OPCUAClient.create(...)` |

O servidor OPC UA do CLP precisa, portanto, aceitar conexões sem segurança e sessões anônimas.

**NodeIds lidos** (identificadores numéricos, constante `IDS`):

| Variável | Identificador |
|---|---|
| `contMetais` | `i=3` |
| `contPlasticos` | `i=4` |
| `contVidros` | `i=5` |
| `contPecasTotal` | `i=6` |
| `estadoMaquina` | `i=7` |

O índice do namespace (`ns=`) não está fixo no código. Ao conectar, o backend lê a lista de namespaces do servidor (`NamespaceArray`, NodeId `ns=0;i=2255`), procura a URI `http://vue` e monta cada NodeId como `ns=<índice>;i=<identificador>`.

**Conceitos OPC UA usados no código:**
- **Endpoint:** endereço onde o cliente se conecta ao servidor (`opc.tcp://IP:porta`).
- **Namespace:** agrupa nós. Cada nó usa o índice da sua URI na lista `NamespaceArray`.
- **NodeId:** identificador único de cada variável no servidor (`ns=<índice>;i=<número>`).

---

## 4. Execução

O CLP precisa estar acessível no endpoint da seção 3 antes que o backend consiga conectar. Se ele não estiver, o backend continua rodando e tenta de novo (seção 6).

### 4.1 Backend

```bash
cd backend
npm start
```

Mensagens que o código imprime no terminal:

```
Backend em http://localhost:3000
[OPC UA] NodeIds lidos:
   contMetais           ns=<índice>;i=3
   contPlasticos        ns=<índice>;i=4
   contVidros           ns=<índice>;i=5
   contPecasTotal       ns=<índice>;i=6
   estadoMaquina        ns=<índice>;i=7
[OPC UA] CONECTADO - Comunicação com o S7-1500 ativa
```

Na primeira execução, o `node-opcua` também mostra `Creating default certificate ... please wait`.

Depois de conectar, o backend lê as cinco variáveis a cada **500 ms**.

**JSON de conferência:** `GET http://localhost:3000/` retorna:

```json
{
  "backend": "Funcionando",
  "opcUa": "Conectado",
  "mensagem": "Comunicação com o S7-1500 ativa",
  "ultimaLeitura": "<data/hora ISO da última leitura>",
  "producao": {
    "contMetais": 0,
    "contPlasticos": 0,
    "contVidros": 0,
    "contPecasTotal": 0,
    "estadoMaquina": 0
  }
}
```

**Eventos Socket.IO** emitidos pelo backend:

| Evento | Conteúdo | Quando |
|---|---|---|
| `dadosProducao` | as cinco variáveis + `ultimaLeitura` | a cada leitura bem-sucedida e quando um cliente se conecta |
| `opcStatus` | `true`/`false` | quando o status da conexão OPC UA muda e quando um cliente se conecta |
| `opcInfo` | `{ conectado, mensagem, ultimaLeitura }` | quando o status ou a mensagem muda e quando um cliente se conecta |

### 4.2 Interface Vue

```bash
cd frontend
npm run dev
```

Abra o endereço que o Vite mostra no terminal (por padrão `http://localhost:5173`). O Vite redireciona `/socket.io` para `http://localhost:3000` ([frontend/vite.config.js](frontend/vite.config.js)), por isso a interface deve ser aberta pelo `npm run dev` com o backend rodando.

A interface mostra:
- o selo **PLC conectado** (verde) ou **PLC desconectado** (vermelho) no cabeçalho;
- quatro indicadores e uma tabela: **Produção total**, **Metal**, **Plástico** e **Vidro**;
- **Estado da aplicação**, com o valor numérico de `estadoMaquina`;
- **Comunicação OPC UA**, com a mensagem de status do backend e o horário da última leitura.

Os valores são atualizados a cada evento `dadosProducao`, sem recarregar a página.

---

## 5. Testes

| Teste | Como fazer | Resultado esperado |
|---|---|---|
| Dependências instaladas | `npm ls` nas duas pastas (seção 2) | Pacotes listados sem erro |
| Backend inicia | `npm start` em `backend/` | `Backend em http://localhost:3000` |
| Sessão OPC UA | Observar o terminal do backend | NodeIds listados e `[OPC UA] CONECTADO` |
| JSON igual ao DB | Comparar `GET http://localhost:3000/` com as variáveis online no TIA Portal | Mesmos valores |
| Interface conectada | `npm run dev` em `frontend/` e abrir no navegador | Selo **PLC conectado** |
| Atualização automática | Passar novas peças na planta, sem recarregar a página | Indicadores mudam e ficam iguais ao JSON e ao DB |
| Perda e recuperação | Seção 6 | Status muda para desconectado e volta a conectado sozinho |

---

## 6. Perda de comunicação e recuperação

**OPC UA (CLP → backend).** Se a conexão cair, uma leitura falhar ou o servidor não responder em 3 s, o backend:
1. imprime `[OPC UA] DESCONECTADO - Sem comunicação: <motivo>. Tentando reconectar.`;
2. envia o novo status à interface: selo **PLC desconectado** e a mesma mensagem no quadro *Comunicação OPC UA*;
3. passa a devolver `"opcUa": "Desconectado"` no JSON;
4. fecha a sessão e tenta reconectar a cada 3 s, sem precisar reiniciar o backend.

Durante a falha, o JSON e a interface continuam mostrando os últimos valores lidos. Depois da reconexão, voltam a mostrar os valores atuais do CLP.

**Socket.IO (backend → interface).** Se o backend for encerrado, a interface mostra **PLC desconectado** com a mensagem *"Conexão com o backend interrompida. Reconectando..."* e depois *"Backend indisponível. Tentando reconectar..."*. Quando o backend volta, a interface reconecta sozinha e recebe o estado atual.

O backend e a interface não escrevem nos contadores. Qualquer valor exibido depois da reconexão é o que está no CLP naquele momento.

**Mensagens de erro do backend:**

| Mensagem | Significado |
|---|---|
| `o servidor OPC UA não respondeu em opc.tcp://…` | Não houve resposta no endpoint configurado |
| `namespace http://vue não encontrado. Confira a server interface no TIA.` | A URI `http://vue` não existe no servidor |
| `não foi possível ler o NamespaceArray do servidor OPC UA` | A leitura de `ns=0;i=2255` falhou |
| `leitura inválida em <variável> (<NodeId>): <status>. Confira os identificadores no TIA.` | O NodeId não existe ou não pôde ser lido |
| `conexão com o S7-1500 perdida` | O `node-opcua` sinalizou perda de conexão |

---

## 7. Estrutura

```
backend/
  server.js        cliente OPC UA + API HTTP + Socket.IO
  package.json
frontend/
  src/App.vue      interface (indicadores e status)
  src/main.js
  vite.config.js   proxy de /socket.io para o backend
README.md
```

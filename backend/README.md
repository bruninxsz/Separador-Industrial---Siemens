# Backend OPC UA

O backend consulta o S7-1500 via OPC UA em modo somente leitura e envia os valores ao Vue por Socket.IO.

## Configuração

1. Confira o endereço `ENDPOINT` em `server.js` e ajuste o IP para o da instância do PLCSIM Advanced.
2. No TIA Portal, habilite a server interface OPC UA com o namespace URI `http://vue`.
3. Confira os IDs `3` a `7` em `IDS` no `server.js`; eles devem corresponder às variáveis do `DB_Producao_N1` publicadas pela interface.
4. Execute `npm install` e `npm start` neste diretório.

O backend descobre automaticamente o índice do namespace `http://vue`, lê os contadores e o estado a cada 500 ms e tenta reconectar se a conexão cair. O servidor OPC UA do PLC precisa estar habilitado, aceitar conexão sem segurança (conforme o exemplo) e permitir a leitura das variáveis.

Para iniciar a interface, execute `npm install` e `npm run dev` no diretório `frontend`. O Vite encaminha o Socket.IO ao backend em `http://localhost:3000`.
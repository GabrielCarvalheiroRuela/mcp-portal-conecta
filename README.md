# MCP de funcionalidades

Servidor MCP **somente leitura** da matriz de funcionalidades das plataformas de integração (Tray, ShopPub,
Convertize, Climba, Nuvemshop). O Claude consulta; quem cadastra e edita é o portal. Req. Altera 474225.

```
Claude Code ──HTTPS + Bearer──► Traefik ──► mcp-funcionalidades ──SELECT──► views VW_* do banco do Monint
```

Ele lê direto as views do banco, com um usuário que só tem `SELECT` nelas. Não passa pela API do Monint: o único
login de serviço que a API tem é o de lojista, que também pode gravar em `/produtos` e `/plataformas`.

## Ferramentas

| Ferramenta | O que devolve |
|---|---|
| `listar_plataformas` | Plataformas cadastradas, contagem por status e cobertura |
| `listar_funcionalidades` | Funcionalidades com status, teste, observação, workflow, responsável. Filtros: plataforma, módulo, status, teste, responsável, busca, limite |
| `obter_funcionalidade` | Uma funcionalidade com a descrição completa e a situação em cada plataforma |
| `resumo_cobertura` | Cobertura por plataforma e por módulo |

## Saúde

- `GET /health`: o processo está de pé. Não toca no banco, de propósito: é o que o Docker usa para decidir se reinicia o container.
- `GET /status`: `{"mcp":true,"banco":true|false}`. Sem token, sem detalhes. Confere se o banco responde e se a view
  `VW_COBPLA` está liberada para o usuário do MCP. O resultado vale 10 s, então pode ser consultado à vontade. É o que o selo
  "MCP ativo" da aba Funcionalidades do portal mostra (pelo nginx do portal, que repassa `/mcp-status` para cá).

## Onde ele fica

O MCP **não tem endereço público**. Roda só na rede Docker do servidor (`network_traefik`), sem labels do Traefik:

```
n8n (agente do chat do portal) ──HTTP + Bearer──► mcp-funcionalidades:3002/mcp ──SELECT──► views VW_* do banco
nginx do portal (/mcp-status, /mcp-conexao) ─────► mcp-funcionalidades:3002
```

O MCP lê o banco: não deixe a porta 3002 roteada para a internet. Se um dia precisar de acesso de fora (Claude Code nas
máquinas da equipe), crie o DNS, devolva os labels do Traefik e preencha `MCP_URL_PUBLICA`.

## Subir no servidor

1. **Banco.** Rode `monitoramento-pedpen/sql/003_funcionalidades.sql` (um comando por vez) e, no fim dele, crie o
   usuário `mcp_func` (passo 8, está comentado).
2. **Variáveis.** Copie `.env.example` para `.env`, ou cadastre as mesmas variáveis na stack do Portainer.
   O token: `openssl rand -hex 32`. Deixe `MCP_URL_PUBLICA` vazio.
3. **Subir.**

   ```bash
   docker compose up -d --build
   ```

4. **Conferir**, de dentro de um container da mesma rede (ex.: o do portal):

   ```bash
   wget -qO- http://mcp-funcionalidades:3002/health
   ```

   Pelo portal, o selo "MCP ativo" da aba Funcionalidades usa o `/status`.

## Conectar o Claude Code

Sem endereço público, o botão **Conectar MCP** do portal responde que o MCP só atende a rede interna (503): não existe
URL que funcione fora do servidor. O `GET /conexao` continua conferindo o perfil DEV/ADM na API do Monint
(`GET /usuarios/me`) e volta a entregar `{nome, url, token}` quando `MCP_URL_PUBLICA` for preenchido.

Na sua máquina, com `npm start` (porta 3002), dá para conectar o Claude Code ao MCP local:
`claude mcp add --transport http funcionalidades http://localhost:3002/mcp --header "Authorization: Bearer <token>"`.

## Trocar o token ou a senha do banco

Mude a variável, `docker compose up -d` e atualize a variável de quem usa o Claude. Não há sessão: a troca vale na hora.

## Desenvolver

```bash
npm install
npm run build
MCP_TOKEN=<32+ caracteres> DB_HOST=... DB_NAME=... DB_USER=mcp_func DB_PASSWORD=... npm start
```

O `npm start` lê o `.env` da pasta (`node --env-file=.env`, Node 20.6+), então o token e o banco vêm de lá; sem o arquivo, ele para com
erro. O `.env` não vai para o git. No Docker o container roda `node dist/index.js` direto, com as variáveis do compose.

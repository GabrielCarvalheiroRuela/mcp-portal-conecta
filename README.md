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

## Subir no servidor

1. **Banco.** Rode `monitoramento-pedpen/sql/003_funcionalidades.sql` (um comando por vez) e, no fim dele, crie o
   usuário `mcp_func` (passo 8, está comentado).
2. **DNS.** Crie um registro para o endereço do MCP (ex.: `mcp.citelsoftware.com.br`) apontando para o servidor
   onde roda o Traefik. Sem isso o certificado (`tlschallenge`) não sai.
3. **Variáveis.** Copie `.env.example` para `.env`, ou cadastre as mesmas variáveis na stack do Portainer.
   O token: `openssl rand -hex 32`.
4. **Subir.**

   ```bash
   docker compose up -d --build
   ```

5. **Conferir.**

   ```bash
   curl -s https://mcp.citelsoftware.com.br/health
   curl -s -o /dev/null -w "%{http_code}\n" -X POST https://mcp.citelsoftware.com.br/mcp   # 401 sem token
   ```

## Conectar o Claude Code

**Pelo portal:** a aba Plataformas > Funcionalidades tem o botão **Conectar MCP**, que mostra o comando pronto (com o token)
e um botão de copiar. Só DEV e ADM veem (`GET /funcionalidades/mcp` na API devolve 403 aos demais). O comando sai da
configuração da API, não do código do portal: defina `MCP_FUNCIONALIDADES_URL` (o endereço do `/mcp`, como
`https://mcp.citelsoftware.com.br/mcp`) e `MCP_FUNCIONALIDADES_TOKEN` (o mesmo `MCP_TOKEN` deste servidor) no ambiente da API.
Para trocar o token, mude as duas variáveis (a do MCP e a da API); o portal não precisa ser publicado de novo.

**À mão:**

Guarde o token numa variável de ambiente de cada pessoa e use um `.mcp.json` no projeto (sem o token dentro):

```json
{
  "mcpServers": {
    "funcionalidades": {
      "type": "http",
      "url": "https://mcp.citelsoftware.com.br/mcp",
      "headers": { "Authorization": "Bearer ${FUNCIONALIDADES_MCP_TOKEN}" }
    }
  }
}
```

Ou, só para você: `claude mcp add --transport http funcionalidades https://mcp.citelsoftware.com.br/mcp --header "Authorization: Bearer <token>"`.

## Trocar o token ou a senha do banco

Mude a variável, `docker compose up -d` e atualize a variável de quem usa o Claude. Não há sessão: a troca vale na hora.

## Desenvolver

```bash
npm install
npm run build
MCP_TOKEN=<32+ caracteres> DB_HOST=... DB_NAME=... DB_USER=mcp_func DB_PASSWORD=... npm start
```

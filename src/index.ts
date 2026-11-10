import { createHash, timingSafeEqual } from 'node:crypto'
import express from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { bancoDisponivel, criarServidor, encerrarBanco } from './servidor.js'

const TOKEN = process.env.MCP_TOKEN ?? ''
if (TOKEN.length < 32) {
  console.error('MCP_TOKEN ausente ou com menos de 32 caracteres. Gere um com: openssl rand -hex 32')
  process.exit(1)
}
for (const nome of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
  if (!process.env[nome]) {
    console.error(`${nome} não informado.`)
    process.exit(1)
  }
}

// Compara o hash (tamanho fixo) com timingSafeEqual: não vaza o tamanho nem o conteúdo do token pelo tempo de resposta.
const sha256 = (texto: string) => createHash('sha256').update(texto).digest()
const HASH_TOKEN = sha256(TOKEN)

function tokenValido(cabecalho: string | undefined): boolean {
  const m = /^Bearer (.+)$/.exec(cabecalho ?? '')
  return m !== null && timingSafeEqual(sha256(m[1]), HASH_TOKEN)
}

const app = express()
app.disable('x-powered-by')

// Sem autenticação e sem tocar no banco: é só o healthcheck do Docker e do Traefik.
app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

// Aberto, para o selo "MCP ativo" do portal (passando pelo nginx). Diz só se o MCP está de pé e se o banco responde, sem
// nenhum detalhe. Ao contrário do /health, toca no banco, mas com cache de 10 s; o /health continua sem banco porque
// é o que o Docker usa para decidir se reinicia o container.
app.get('/status', async (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ mcp: true, banco: await bancoDisponivel() })
})

app.use('/mcp', (req, res, next) => {
  if (!tokenValido(req.header('authorization'))) {
    res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'Token inválido ou ausente.' })
    return
  }
  next()
})
app.use(express.json({ limit: '100kb' }))

// Modo sem sessão: cada POST cria o servidor e o transporte, responde e descarta.
app.post('/mcp', async (req, res) => {
  const servidor = criarServidor()
  const transporte = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transporte.close()
    void servidor.close()
  })
  try {
    await servidor.connect(transporte)
    await transporte.handleRequest(req, res, req.body)
  } catch (e) {
    console.error(e)
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Erro interno.' }, id: null })
    }
  }
})

const somentePost: express.RequestHandler = (_req, res) => {
  res
    .status(405)
    .set('Allow', 'POST')
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Método não permitido.' }, id: null })
}
app.get('/mcp', somentePost)
app.delete('/mcp', somentePost)

const porta = Number(process.env.PORT ?? 3002)
const http = app.listen(porta, () => console.log(`MCP de funcionalidades na porta ${porta}`))

function encerrar() {
  http.close(() => void encerrarBanco().finally(() => process.exit(0)))
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', encerrar)
process.on('SIGINT', encerrar)

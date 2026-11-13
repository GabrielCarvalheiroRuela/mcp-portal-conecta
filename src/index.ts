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

const porta = Number(process.env.PORT ?? 3002)

// Para a tela "Conectar MCP" do portal. URL_PUBLICA é o endereço do /mcp como o Claude o enxerga; API_URL é a API do
// Monint, que o MCP consulta só para saber o perfil de quem pede o token. Sem a variável (npm start na máquina), vale o
// localhost. No servidor o MCP só atende a rede Docker, então o compose a deixa VAZIA e o /conexao responde 503 em vez
// de entregar um endereço que ninguém de fora alcança.
const URL_PUBLICA = process.env.MCP_URL_PUBLICA ?? `http://localhost:${porta}/mcp`
const API_URL = (process.env.MONITORAMENTO_API_URL ?? '').replace(/\/+$/, '')

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

// Como conectar o Claude a este servidor: a URL e o token. É uma credencial, então só sai para DEV e ADM. O portal manda o
// JWT do Monint de quem está logado; o MCP não o valida sozinho (não tem o segredo de assinatura): pergunta à API, em
// /usuarios/me, que lê o perfil no banco a cada chamada e devolve 403 a lojista e a token inválido.
app.get('/conexao', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  const autorizacao = req.header('authorization')
  if (!/^Bearer .+/.test(autorizacao ?? '')) {
    res.status(401).json({ error: 'Faça login no portal para ver a conexão do MCP.' })
    return
  }
  if (!URL_PUBLICA) {
    res.status(503).json({ error: 'Este MCP não tem endereço público: ele só atende a rede interna do servidor (n8n e portal).' })
    return
  }
  if (!API_URL) {
    res.status(503).json({ error: 'O MCP não está configurado para conferir o seu perfil (falta MONITORAMENTO_API_URL).' })
    return
  }

  let usuario: { email?: string; perfil?: string }
  try {
    const resposta = await fetch(`${API_URL}/usuarios/me`, {
      headers: { Authorization: autorizacao! },
      signal: AbortSignal.timeout(5000),
    })
    if (resposta.status === 401 || resposta.status === 403) {
      res.status(401).json({ error: 'Sessão inválida. Entre novamente no portal.' })
      return
    }
    if (!resposta.ok) {
      throw new Error(`/usuarios/me respondeu ${resposta.status}`)
    }
    usuario = (await resposta.json()) as { email?: string; perfil?: string }
  } catch (e) {
    console.error('Não foi possível conferir o perfil na API:', e)
    res.status(503).json({ error: 'Não foi possível conferir o seu perfil: a API de monitoramento não respondeu.' })
    return
  }

  if (usuario.perfil !== 'DEV' && usuario.perfil !== 'ADM') {
    res.status(403).json({ error: 'Só os perfis DEV e ADM podem ver a conexão do MCP.' })
    return
  }
  console.log(`Conexão do MCP consultada por ${usuario.email ?? '(sem e-mail)'}`)
  res.json({ nome: 'funcionalidades', url: URL_PUBLICA, token: TOKEN })
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

const http =app.listen(porta, () => console.log(`MCP de funcionalidades na porta ${porta}`))

function encerrar() {
  http.close(() => void encerrarBanco().finally(() => process.exit(0)))
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', encerrar)
process.on('SIGINT', encerrar)

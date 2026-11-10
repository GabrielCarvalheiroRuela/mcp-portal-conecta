import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import mysql from 'mysql2/promise'
import { z } from 'zod'

const STATUS = ['IMPLEMENTADO', 'PARCIAL', 'NAO_IMPLEMENTADO', 'NAO_SE_APLICA'] as const
const TESTE = ['NAO_TESTADO', 'TESTADO', 'COM_FALHA'] as const

// Só as views VW_STAFUN, VW_COBFUN e VW_COBPLA, com um usuário que só tem SELECT nelas (ver sql/003 da API).
// O banco derruba conexão ociosa (a API usa max-lifetime de 45 s), então o pool a descarta cedo e a consulta
// refaz a tentativa uma vez quando pega uma conexão já morta.
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 3306),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  charset: 'utf8mb4',
  connectionLimit: 3,
  maxIdle: 1,
  idleTimeout: 30_000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
  connectTimeout: 10_000,
  decimalNumbers: true, // SUM/ROUND voltam como DECIMAL; sem isto chegariam como texto
  dateStrings: true, // evita o driver converter DATETIME pelo fuso do container
})

export const encerrarBanco = () => pool.end()

const VALIDADE_STATUS_MS = 10_000
let ultimoStatus: { em: number; ok: boolean } | null = null
let statusEmAndamento: Promise<boolean> | null = null

/**
 * O banco responde e a view que as ferramentas usam existe e está liberada para este usuário? É o que o selo do portal
 * mostra. O resultado vale 10 s e uma checagem em andamento é compartilhada, então várias telas consultando juntas
 * (ou alguém martelando o /status, que não exige token) viram no máximo uma ida ao banco a cada 10 s.
 */
export function bancoDisponivel(): Promise<boolean> {
  if (ultimoStatus && Date.now() - ultimoStatus.em < VALIDADE_STATUS_MS) {
    return Promise.resolve(ultimoStatus.ok)
  }
  statusEmAndamento ??= pool
    .query({ sql: 'SELECT 1 FROM VW_COBPLA LIMIT 1', timeout: 3000 })
    .then(
      () => true,
      (e: unknown) => {
        // O motivo fica só no log do container: o /status é aberto e não pode contar host, usuário ou tabela.
        console.error('status: banco indisponível:', (e as { code?: string }).code ?? e)
        return false
      },
    )
    .then((ok) => {
      ultimoStatus = { em: Date.now(), ok }
      statusEmAndamento = null
      return ok
    })
  return statusEmAndamento
}

const CONEXAO_PERDIDA = new Set(['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE'])

async function consultar<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  for (let tentativa = 0; ; tentativa++) {
    try {
      const [linhas] = await pool.query(sql, params)
      return linhas as T[]
    } catch (e) {
      const codigo = (e as { code?: string }).code ?? ''
      if (tentativa === 0 && CONEXAO_PERDIDA.has(codigo)) continue
      throw e
    }
  }
}

/** Remove os campos nulos para a resposta ocupar menos do contexto do Claude. */
function semNulos<T extends object>(linha: T): Partial<T> {
  return Object.fromEntries(Object.entries(linha).filter(([, v]) => v !== null)) as Partial<T>
}

/** Texto digitado vira trecho de LIKE sem que % e _ virem curinga. */
const contem = (texto: string) => `%${texto.replace(/[\\%_]/g, '\\$&')}%`

const COLUNAS_FUNCIONALIDADE = `
  FUN_SISEXT AS plataforma, FUN_CODFUN AS id, FUN_MODULO AS modulo, FUN_NOMFUN AS nome, FUN_DESFUN AS descricao,
  FUN_STATUS AS status, FUN_RESTES AS teste, FUN_DHTEST AS testado_em, FUN_USRTST AS testado_por,
  FUN_OBSERV AS observacao, FUN_CFGERP AS config_erp, FUN_WORKFL AS workflow, FUN_RESPON AS responsavel,
  FUN_PRIORI AS prioridade, FUN_DTPREV AS previsao, FUN_REQALT AS requisito_altera,
  FUN_USRALT AS alterado_por, FUN_DHUALT AS alterado_em`

const COLUNAS_COBERTURA = `
  FUN_SISEXT AS plataforma, FUN_DESPLA AS nome, FUN_QTDTOT AS total, FUN_QTDIMP AS implementadas,
  FUN_QTDPAR AS parciais, FUN_QTDNAO AS nao_implementadas, FUN_QTDNSA AS nao_se_aplica,
  FUN_QTDTST AS testadas, FUN_PERCOB AS cobertura_percentual`

function resposta(dados: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(dados, null, 2) }] }
}

function falha(e: unknown) {
  console.error(e)
  // O erro do banco fica só no log do container: pode trazer host, usuário e nome de tabela.
  return {
    isError: true,
    content: [{ type: 'text' as const, text: 'Não foi possível consultar as funcionalidades agora. Tente de novo.' }],
  }
}

const SOMENTE_LEITURA = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

type Linha = Record<string, unknown>

/** Uma instância por requisição: o servidor HTTP roda sem sessão. */
export function criarServidor(): McpServer {
  const servidor = new McpServer({ name: 'funcionalidades', version: '0.1.0' })

  servidor.registerTool(
    'listar_plataformas',
    {
      title: 'Listar plataformas',
      description:
        'Lista as plataformas de integração cadastradas, com a contagem de funcionalidades por status ' +
        'e o percentual de cobertura de cada uma. O parcial vale meia funcionalidade e "não se aplica" sai da conta.',
      annotations: SOMENTE_LEITURA,
    },
    async () => {
      try {
        const linhas = await consultar<Linha>(`SELECT ${COLUNAS_COBERTURA} FROM VW_COBPLA ORDER BY FUN_DESPLA`)
        return resposta({ plataformas: linhas })
      } catch (e) {
        return falha(e)
      }
    },
  )

  servidor.registerTool(
    'listar_funcionalidades',
    {
      title: 'Listar funcionalidades',
      description:
        'Lista funcionalidades com a situação em cada plataforma: status, se foi testada, observação, parâmetros do ERP, ' +
        'workflow, responsável, prioridade, previsão e requisito no Altera. Todos os filtros são opcionais e se somam. ' +
        'Funcionalidade sem registro na plataforma aparece como NAO_IMPLEMENTADO.',
      inputSchema: {
        plataforma: z.string().max(50).optional().describe('Identificador da plataforma, ex.: tray (veja listar_plataformas).'),
        modulo: z.string().max(80).optional().describe('Trecho do nome do módulo, ex.: Pedidos.'),
        status: z.enum(STATUS).optional(),
        teste: z.enum(TESTE).optional().describe('Situação do teste.'),
        responsavel: z.string().max(100).optional().describe('Trecho do nome do responsável.'),
        busca: z.string().max(100).optional().describe('Trecho do nome, da descrição ou da observação.'),
        limite: z.number().int().min(1).max(200).default(50).describe('Quantidade máxima de linhas (padrão 50).'),
      },
      annotations: SOMENTE_LEITURA,
    },
    async ({ plataforma, modulo, status, teste, responsavel, busca, limite }) => {
      const condicoes: string[] = []
      const params: unknown[] = []
      if (plataforma) (condicoes.push('FUN_SISEXT = ?'), params.push(plataforma))
      if (modulo) (condicoes.push('FUN_MODULO LIKE ?'), params.push(contem(modulo)))
      if (status) (condicoes.push('FUN_STATUS = ?'), params.push(status))
      if (teste) (condicoes.push('FUN_RESTES = ?'), params.push(teste))
      if (responsavel) (condicoes.push('FUN_RESPON LIKE ?'), params.push(contem(responsavel)))
      if (busca) {
        condicoes.push('(FUN_NOMFUN LIKE ? OR FUN_DESFUN LIKE ? OR FUN_OBSERV LIKE ?)')
        params.push(contem(busca), contem(busca), contem(busca))
      }
      const onde = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : ''

      try {
        const [{ total }] = await consultar<{ total: number }>(`SELECT COUNT(*) AS total FROM VW_STAFUN ${onde}`, params)
        const linhas = await consultar<Linha>(
          `SELECT ${COLUNAS_FUNCIONALIDADE} FROM VW_STAFUN ${onde} ORDER BY FUN_SISEXT, FUN_ORDFUN, FUN_NOMFUN LIMIT ?`,
          [...params, limite],
        )
        return resposta({ total, retornadas: linhas.length, funcionalidades: linhas.map(semNulos) })
      } catch (e) {
        return falha(e)
      }
    },
  )

  servidor.registerTool(
    'obter_funcionalidade',
    {
      title: 'Obter funcionalidade',
      description:
        'Devolve uma funcionalidade pelo id (o campo "id" de listar_funcionalidades) com a descrição completa e a ' +
        'situação em cada plataforma, ou só na plataforma informada.',
      inputSchema: {
        id: z.number().int().positive(),
        plataforma: z.string().max(50).optional().describe('Restringe a uma plataforma, ex.: tray.'),
      },
      annotations: SOMENTE_LEITURA,
    },
    async ({ id, plataforma }) => {
      try {
        const linhas = await consultar<Linha>(
          `SELECT ${COLUNAS_FUNCIONALIDADE} FROM VW_STAFUN WHERE FUN_CODFUN = ?${plataforma ? ' AND FUN_SISEXT = ?' : ''} ORDER BY FUN_SISEXT`,
          plataforma ? [id, plataforma] : [id],
        )
        if (linhas.length === 0) {
          return { isError: true, content: [{ type: 'text' as const, text: 'Funcionalidade não encontrada.' }] }
        }
        const { id: codigo, modulo, nome, descricao } = linhas[0]
        const situacoes = linhas.map(({ id: _id, modulo: _m, nome: _n, descricao: _d, ...resto }) => semNulos(resto))
        return resposta({ id: codigo, modulo, nome, descricao: descricao ?? null, plataformas: situacoes })
      } catch (e) {
        return falha(e)
      }
    },
  )

  servidor.registerTool(
    'resumo_cobertura',
    {
      title: 'Resumo de cobertura',
      description:
        'Cobertura por plataforma e por módulo: contagem por status, quantas já foram testadas e o percentual ' +
        '(implementado + 0,5 x parcial) / (total - não se aplica). Percentual ausente quer dizer que nada se aplica.',
      inputSchema: {
        plataforma: z.string().max(50).optional().describe('Restringe a uma plataforma, ex.: tray.'),
      },
      annotations: SOMENTE_LEITURA,
    },
    async ({ plataforma }) => {
      const onde = plataforma ? 'WHERE FUN_SISEXT = ?' : ''
      const params = plataforma ? [plataforma] : []
      try {
        const geral = await consultar<Linha>(`SELECT ${COLUNAS_COBERTURA} FROM VW_COBPLA ${onde} ORDER BY FUN_DESPLA`, params)
        const modulos = await consultar<Linha>(
          `SELECT ${COLUNAS_COBERTURA}, FUN_MODULO AS modulo FROM VW_COBFUN ${onde} ORDER BY FUN_DESPLA, FUN_ORDFUN`,
          params,
        )
        const plataformas = geral.map((p) => ({
          ...p,
          modulos: modulos
            .filter((m) => m.plataforma === p.plataforma)
            .map(({ plataforma: _p, nome: _n, ...resto }) => resto),
        }))
        return resposta({ plataformas })
      } catch (e) {
        return falha(e)
      }
    },
  )

  return servidor
}

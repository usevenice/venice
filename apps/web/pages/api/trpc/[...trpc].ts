import '@usevenice/app-config/register.node'

import * as trpcNext from '@trpc/server/adapters/next'
import {TRPCError} from '@trpc/server'
import {getCookie} from 'cookies-next'
import type {NextApiHandler, NextApiRequest, NextApiResponse} from 'next'

import {
  backendEnv,
  makePostgresClient,
  syncEngine,
  veniceRouter,
} from '@usevenice/app-config/backendConfig'
import {baseRouter, parseWebhookRequest} from '@usevenice/engine-backend'
import {fromMaybeArray, makeUlid, R, safeJSONParse, z} from '@usevenice/util'

import {kAccessToken} from '../../../contexts/atoms'

export function getAccessToken(req: NextApiRequest) {
  return (
    fromMaybeArray(req.query[kAccessToken] ?? [])[0] ??
    req.headers.authorization?.match(/^Bearer (.+)/)?.[1] ??
    R.pipe(
      getCookie(kAccessToken, {req}),
      (v) =>
        typeof v === 'string' ? (safeJSONParse(v) as unknown) : undefined,
      (v) => (typeof v === 'string' ? v : undefined),
    )
  )
}

// Can these be expressed as custom postgres functions?

async function dropDbUser(userId: string) {
  const pgClient = makePostgresClient({
    databaseUrl: backendEnv.POSTGRES_OR_WEBHOOK_URL,
  })
  const sql = pgClient.sql
  const pool = await pgClient.getPool()
  const usr = sql.identifier([`usr_${userId}`])

  await pool.query(
    sql`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${usr}`,
  )
  await pool.query(sql`REVOKE USAGE ON SCHEMA public FROM ${usr}`)
  await pool.query(sql`DROP USER ${usr}`)
  await pool.query(
    sql`UPDATE auth.users SET raw_user_meta_data = raw_user_meta_data - 'apiKey' WHERE id = ${userId}`,
  )
}

async function createDbUser(userId: string) {
  const pgClient = makePostgresClient({
    databaseUrl: backendEnv.POSTGRES_OR_WEBHOOK_URL,
  })
  const sql = pgClient.sql
  const pool = await pgClient.getPool()

  const existing = await pool.maybeOneFirst(sql`
    SELECT
      raw_user_meta_data ->> 'apiKey'
    FROM
      auth.users
    WHERE
      id = ${userId}
      AND starts_with (raw_user_meta_data ->> 'apiKey', 'key_')
  `)
  if (existing) {
    return {usr: `usr_${userId}`, apiKey: existing}
  }

  const usr = sql.identifier([`usr_${userId}`])
  const apiKey = `key_${makeUlid()}`

  await pool.query(sql`CREATE USER ${usr} PASSWORD ${sql.literalValue(apiKey)}`)
  await pool.query(sql`GRANT USAGE ON SCHEMA public TO ${usr}`)
  await pool.query(
    sql`GRANT SELECT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${usr}`,
  )
  await pool.query(sql`REVOKE ALL PRIVILEGES ON public.migrations FROM ${usr}`)
  await pool.query(sql`REVOKE ALL PRIVILEGES ON public.integration FROM ${usr}`)
  await pool.query(
    sql`UPDATE auth.users SET raw_user_meta_data = raw_user_meta_data || ${sql.jsonb(
      {apiKey},
    )} WHERE id = ${userId}`,
  )

  return {usr, apiKey}
}

const customRouter = baseRouter()
  .middleware(({next, ctx, path}) => {
    if (!ctx.userId) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: `Auth required: ${path}`,
      })
    }
    return next({ctx: {...ctx, userId: ctx.userId}})
  })
  .mutation('dropDbUser', {
    input: z.object({}),
    resolve: async ({ctx}) => await dropDbUser(ctx.userId),
  })
  .mutation('createDbUser', {
    input: z.object({}),
    resolve: async ({ctx}) => await createDbUser(ctx.userId),
  })
  .mutation('executeSql', {
    input: z.object({sql: z.string()}),
    output: z.any(),
    resolve: async ({input, ctx}) => {
      const adminUrl = new URL(backendEnv.POSTGRES_OR_WEBHOOK_URL)
      const {usr, apiKey} = await createDbUser(ctx.userId)
      const userUrl = `${adminUrl.protocol}//${usr}:${apiKey}@${adminUrl.hostname}:${adminUrl.port}${adminUrl.pathname}`
      const pgClient = makePostgresClient({databaseUrl: userUrl})

      const pool = await pgClient.getPool()
      // @ts-expect-error
      const query = pgClient.sql([input.sql])
      const res = await pool.query(query)
      return res.rows
    },
  })

export function respondToCORS(req: NextApiRequest, res: NextApiResponse) {
  // https://vercel.com/support/articles/how-to-enable-cors

  res.setHeader('Access-Control-Allow-Credentials', 'true')
  // Need to use the request origin for credentials-mode "include" to work
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*')
  // prettier-ignore
  res.setHeader('Access-Control-Allow-Methods', req.headers['access-control-request-method'] ?? '*')
  // prettier-ignore
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] ?? '*')
  if (req.method === 'OPTIONS') {
    console.log('Respond to OPTIONS request', req.headers.origin)
    res.status(200).end()
    return true
  }
  return false
}

const handler = trpcNext.createNextApiHandler({
  router: veniceRouter.merge(customRouter),
  createContext: ({req}) => {
    console.log('[createContext]', {
      query: req.query,
      headers: req.headers,
    })
    const ctx = syncEngine.zContext.parse<'typed'>({
      accessToken: getAccessToken(req),
    })
    console.log('[createContext] Got ctx', ctx)
    return ctx
  },
  onError: ({error}) => {
    console.warn('error', error)
  },
})

// This probably needs to be refactored into sync-backend package together with
// perhaps the cli package
// - [ ] Remove RouterContext no longer needed
// - [ ] Do the same logic for veniceCli httpServer that does not use next
export default R.identity<NextApiHandler>((req, res) => {
  if (respondToCORS(req, res)) {
    return
  }

  const segments = req.query['trpc'] as [string] | string
  if (Array.isArray(segments) && parseWebhookRequest.isWebhook(segments)) {
    const {procedure, ...ret} = parseWebhookRequest({
      method: req.method,
      headers: req.headers,
      pathSegments: segments,
      query: req.query,
      body: req.body,
    })
    req.query = ret.query as typeof req['query']
    req.query['trpc'] = procedure
    req.body = ret.body
  }
  return handler(req, res)
})

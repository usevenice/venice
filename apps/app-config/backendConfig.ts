import type {Link, LinkFactory} from '@usevenice/cdk-core'
import {logLink, makeId, noopMetaService, swapPrefix} from '@usevenice/cdk-core'
import type {EntityPayloadWithExternal} from '@usevenice/cdk-ledger'
import {
  addRemainderByDateLink,
  mapAccountNameAndTypeLink,
  mapStandardEntityLink,
  renameAccountLink,
} from '@usevenice/cdk-ledger'
import {makePostgresMetaService} from '@usevenice/core-integration-postgres'
import {
  makeSyncEngine,
  type inferProcedureInput,
} from '@usevenice/engine-backend'
import {joinPath, R, Rx, zParser} from '@usevenice/util'

import {veniceCommonConfig} from './commonConfig'
import {parseIntConfigsFromRawEnv, zAllEnv} from './env'

export {makePostgresClient} from '@usevenice/integration-postgres'

const env = zParser(zAllEnv).parseUnknown(process.env)

export const backendEnv = env

const usePg = env.POSTGRES_OR_WEBHOOK_URL.startsWith('postgres')

/**
 * This requires the env vars to exist...
 * TODO: Separate it so that the entire config isn't constructed client side
 * and only the minimal needed methods are...
 */
export const veniceBackendConfig = makeSyncEngine.config({
  ...veniceCommonConfig,
  jwtSecretOrPublicKey: env.JWT_SECRET_OR_PUBLIC_KEY,
  getRedirectUrl: (_, ctx) =>
    joinPath(env.NEXT_PUBLIC_SERVER_URL, `ledgers/${ctx.userId}`),
  metaService: usePg
    ? makePostgresMetaService({databaseUrl: env.POSTGRES_OR_WEBHOOK_URL})
    : noopMetaService,
  // TODO: Support other config service such as fs later...
  linkMap: {
    renameAccount: renameAccountLink as LinkFactory,
    log: logLink,
  },
  // Integrations shall include `config`.
  // In contrast, connection shall include `external`
  // We do need to figure out which secrets to tokenize and which one not to though
  // Perhaps the best way is to use `secret_` prefix? (think how we might work with vgs)

  defaultIntegrations: parseIntConfigsFromRawEnv(),
  getLinksForPipeline: ({source, links, destination}) => {
    if (destination.integration.provider.name === 'beancount') {
      return [
        ...links,
        mapStandardEntityLink(source),
        addRemainderByDateLink as Link, // What about just the addRemainder plugin?
        // renameAccountLink({
        //   Ramp: 'Ramp/Posted',
        //   'Apple Card': 'Apple Card/Posted',
        // }),
        mapAccountNameAndTypeLink() as Link,
        logLink({prefix: 'preDest', verbose: true}),
      ]
    }
    if (destination.integration.provider.name === 'alka') {
      return [
        ...links,
        // logLink({prefix: 'preMap'}),
        mapStandardEntityLink(source),
        // prefixIdLink(src.provider.name),
        logLink({prefix: 'preDest'}),
      ]
    }
    return [
      ...links,
      // logLink({prefix: 'preMapStandard', verbose: true}),
      mapStandardEntityLink(source),
      Rx.map((op) =>
        op.type === 'data' &&
        destination.integration.provider.name !== 'postgres'
          ? R.identity({
              ...op,
              data: {
                ...op.data,
                entity: {
                  standard: op.data.entity,
                  external: (op.data as EntityPayloadWithExternal).external,
                },
              },
            })
          : op,
      ),
      logLink({prefix: 'preDest'}),
    ]
  },
  // When do we perform migration?
  getDefaultPipeline: (conn, connectWith) => ({
    id: conn?.id ? swapPrefix(conn.id, 'pipe') : makeId('pipe', 'default'),
    // TODO: Handle default soruce scenario
    source: conn,
    // TODO: Make me parsable from env vars
    destination: connectWith?.destinationId
      ? {id: connectWith?.destinationId as 'conn_postgres'} // Temp fix..
      : usePg
      ? {
          id: 'conn_postgres',
          settings: {databaseUrl: env.POSTGRES_OR_WEBHOOK_URL},
        }
      : {
          id: 'conn_webhook',
          settings: {destinationUrl: env.POSTGRES_OR_WEBHOOK_URL},
        },
  }),
})

export const {router: veniceRouter, ...syncEngine} =
  makeSyncEngine(veniceBackendConfig)
export type VeniceRouter = typeof veniceRouter
export type VeniceInput = inferProcedureInput<
  VeniceRouter['_def']['mutations']['syncPipeline']
>[0]

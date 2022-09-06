import {debugProvider, logLink} from '@ledger-sync/cdk-core'
import {
  addRemainderByDateLink,
  mapAccountNameAndTypeLink,
  mapStandardEntityLink,
  renameAccountLink,
} from '@ledger-sync/cdk-ledger'
import {airtableProvider} from '@ledger-sync/core-integration-airtable'
import {firebaseProvider} from '@ledger-sync/core-integration-firebase'
import {fsProvider, makeFsKVStore} from '@ledger-sync/core-integration-fs'
import {mongodbProvider} from '@ledger-sync/core-integration-mongodb'
import {
  corePostgresProvider,
  makePostgresKVStore,
} from '@ledger-sync/core-integration-postgres'
import {makeRedisKVStore} from '@ledger-sync/core-integration-redis'
import {makeSyncEngine} from '@ledger-sync/engine'
import {beancountProvider} from '@ledger-sync/integration-beancount'
import {foreceiptProvider} from '@ledger-sync/integration-foreceipt'
import {importProvider} from '@ledger-sync/integration-import'
import {oneBrickProvider} from '@ledger-sync/integration-onebrick'
import {plaidProvider} from '@ledger-sync/integration-plaid'
import {postgresProvider} from '@ledger-sync/integration-postgres'
import {rampProvider} from '@ledger-sync/integration-ramp'
import {splitwiseProvider} from '@ledger-sync/integration-splitwise'
import {stripeProvider} from '@ledger-sync/integration-stripe'
import {tellerProvider} from '@ledger-sync/integration-teller'
import {togglProvider} from '@ledger-sync/integration-toggl'
import {wiseProvider} from '@ledger-sync/integration-wise'
import {yodleeProvider} from '@ledger-sync/integration-yodlee'
import {identity, R, Rx, safeJSONParse, z} from '@ledger-sync/util'

function getEnv(key: string, opts?: {json?: boolean; required?: boolean}) {
  return R.pipe(
    z.string({required_error: `process.env[${key}] is required`}),
    (zt) => (!opts?.required ? zt.optional() : zt),
    (zt) => (opts?.json ? zt.transform((arg) => safeJSONParse(arg)) : zt),
    (zt) => zt.parse(process.env[key]),
  )
}
const getKvStore = () => {
  const variant = z
    .enum(['fs', 'postgres', 'redis'])
    .optional()
    .parse(process.env['KV_STORE'])
  switch (variant) {
    case 'fs':
      console.log('[kvStore] fs')
      return makeFsKVStore({
        basePath: getEnv('FS_META_PATH') ?? './data/meta',
      })
    case 'postgres':
      console.log('[kvStore] postgres')
      return makePostgresKVStore({
        databaseUrl: getEnv('POSTGRES_URL', {required: true}),
      })
    case 'redis':
      console.log('[kvStore] redis')
      return makeRedisKVStore({
        redisUrl: getEnv('REDIS_URL'),
      })
    default:
      // This is on the frontend, we need to revise how config works
      // for frontend vs backend so frontend does not import configs
      // which are only intended for the backend.
      return 'FIXME' as unknown as ReturnType<typeof makeRedisKVStore>
  }
}

export const ledgerSyncConfig = makeSyncEngine.config({
  // Turn providers into a map rather than array so that we can prevent from
  // a data-structure level multiple providers with the same `name` being passed in?
  providers: [
    // Core
    debugProvider,
    fsProvider,
    firebaseProvider,
    mongodbProvider,
    corePostgresProvider,
    airtableProvider,
    // Ledger
    plaidProvider,
    beancountProvider,
    importProvider,
    oneBrickProvider,
    tellerProvider,
    stripeProvider,
    rampProvider,
    wiseProvider,
    togglProvider,
    foreceiptProvider,
    yodleeProvider,
    splitwiseProvider,
    postgresProvider,
  ],
  linkMap: {renameAccount: renameAccountLink, log: logLink},
  // Integrations shall include `config`.
  // In contrast, connection shall include `external`
  // We do need to figure out which secrets to tokenize and which one not to though
  // Perhaps the best way is to use `secret_` prefix? (think how we might work with vgs)

  // TODO: Validate these immediately upon launch?
  // TODO: Do not expose any of this to the frontend
  defaultIntegrations: {
    plaid: {
      ...safeJSONParse(process.env['PLAID_CREDENTIALS']),
      clientName: 'Alka',
    },
    teller: safeJSONParse(process.env['TELLER_CREDENTIALS']),
    yodlee: safeJSONParse(process.env['YODLEE_CONFIG']),
    beancount: undefined,
    // onebrick: safeJSONParse(process.env['ONEBRICK_CREDENTIALS']),
    // alka: {
    //   baseDir: './data',
    //   // serviceAccountJson: safeJSONParse(
    //   //   process.env['FIREBASE_SERVICE_ACCOUNT_STAGING'],
    //   // ),
    //   // envName: 'staging',
    // },
  },
  kvStore: getKvStore(),
  // routerUrl: 'http://localhost:3010/api', // apiUrl?
  routerUrl: '/api', // apiUrl?
  getLinksForPipeline: ({src, links, dest}) =>
    dest.provider.name === 'beancount'
      ? [
          ...links,
          mapStandardEntityLink(src),
          addRemainderByDateLink, // What about just the addRemainder plugin?
          // renameAccountLink({
          //   Ramp: 'Ramp/Posted',
          //   'Apple Card': 'Apple Card/Posted',
          // }),
          mapAccountNameAndTypeLink(),
          logLink({prefix: 'preDest', verbose: true}),
        ]
      : dest.provider.name === 'alka'
      ? [
          ...links,
          // logLink({prefix: 'preMap'}),
          mapStandardEntityLink(src),
          // prefixIdLink(src.provider.name),
          logLink({prefix: 'preDest'}),
        ]
      : [
          ...links,
          // logLink({prefix: 'preMapStandard', verbose: true}),
          mapStandardEntityLink(src),
          Rx.map((op) =>
            op.type === 'data' && dest.provider.name !== 'postgres'
              ? identity<typeof op>({
                  ...op,
                  data: {
                    ...op.data,
                    entity: {
                      standard: op.data.entity,
                      external: op.data.external,
                    },
                  },
                })
              : op,
          ),
          logLink({prefix: 'preDest'}),
        ],
  // Default destination connection, may contain integration data
  // Default destination will have to be computed at runtime based on the current
  // user id for example. Will sort this later
  defaultPipeline: {
    dest: {
      provider: 'postgres',
      settings: {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        databaseUrl: process.env['POSTGRES_URL']!,
        // Add migration here later.
      },
      // provider: 'alka',
      // data: {
      //   // authUserJson: safeJSONParse(process.env['FIREBASE_AUTH_USER_STAGING']),
      //   ledgerIds: ['ldgr_default' as Id.ldgr],
      // },
    },
  },
  // defaultDestination: {
  //   provider: 'beancount',
  //   data: {outPath: './data'},
  // },
})

// TODO: Add me back once we are less verbosed
// console.log('Using config', ledgerSyncConfig)

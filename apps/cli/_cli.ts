/* eslint-disable @typescript-eslint/no-unsafe-return */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

/* eslint-disable @typescript-eslint/no-unsafe-argument */
import '@ledger-sync/app-config/register.node'

import {loadedEnv} from '@ledger-sync/app-config/register.node'
import {makePostgresMetaService} from '@ledger-sync/core-integration-postgres'
import {makeJwtClient} from '@ledger-sync/engine-common'
import {makeOneBrickClient} from '@ledger-sync/integration-onebrick'
// Make this import dynamic at runtime, so we can do
// dynamic-cli plaid ......  or
// OBJ=$pathToPlaid dynamic-cli whatever...
// Or perhaps we can make it into a register and/or loader for nodejs
// much like tsx and others
import {makePlaidClient} from '@ledger-sync/integration-plaid'
import {makeRampClient} from '@ledger-sync/integration-ramp'
import {makeStripeClient} from '@ledger-sync/integration-stripe'
import {makeTellerClient} from '@ledger-sync/integration-teller'
import {makeTogglClient} from '@ledger-sync/integration-toggl'
import {makeWiseClient} from '@ledger-sync/integration-wise'
import {makeYodleeClient} from '@ledger-sync/integration-yodlee'
import type {ZFunctionMap} from '@ledger-sync/util'
import {R, safeJSONParse, z, zodInsecureDebug} from '@ledger-sync/util'

import type {CliOpts} from './cli-utils'
import {cliFromZFunctionMap} from './cli-utils'

if (process.env['DEBUG_ZOD']) {
  zodInsecureDebug()
}

if (require.main === module) {
  type ClientMap = Record<string, () => [ZFunctionMap, CliOpts] | ZFunctionMap>
  const clients: ClientMap = {
    env: () =>
      R.mapValues(loadedEnv ?? {}, (v, k) => () => {
        const json = safeJSONParse(v)
        console.log(`[env.${k}]: ${json !== undefined ? 'json' : 'string'}`)
        return json ?? v
      }),
    jwt: () =>
      makeJwtClient({
        secretOrPublicKey: process.env['JWT_SECRET_OR_PUBLIC_KEY']!,
      }),
    pgMeta: () =>
      makePostgresMetaService({
        databaseUrl: z.string().parse(process.env['POSTGRES_URL']),
      }) as unknown as ZFunctionMap,
    plaid: () =>
      makePlaidClient(safeJSONParse(process.env['PLAID_CREDENTIALS'])),
    onebrick: () =>
      makeOneBrickClient(safeJSONParse(process.env['ONEBRICK_CREDENTIALS'])),
    teller: () =>
      makeTellerClient(safeJSONParse(process.env['TELLER_CREDENTIALS'])),
    stripe: () =>
      makeStripeClient(safeJSONParse(process.env['STRIPE_CREDENTIALS'])),
    ramp: () => makeRampClient(safeJSONParse(process.env['RAMP_CONFIG'])),
    wise: () => makeWiseClient(safeJSONParse(process.env['WISE_CREDENTIALS'])),
    toggl: () =>
      makeTogglClient(safeJSONParse(process.env['TOGGL_CREDENTIALS'])),
    yodlee: () =>
      makeYodleeClient(
        safeJSONParse(process.env['YODLEE_CONFIG']),
        safeJSONParse(process.env['YODLEE_CREDS']),
      ),
  }

  const clientFactory = z
    .enum(Object.keys(clients) as [keyof typeof clients], {
      errorMap: () => ({message: 'Invalid process.env.CLI'}),
    })
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    .transform((key) => clients[key]!)
    .parse(process.env['CLI'])

  const [client, opts] = R.pipe(clientFactory(), (r) =>
    Array.isArray(r) ? r : [r],
  )

  cliFromZFunctionMap(client, opts).help().parse()
}

import {
  firebaseProvider,
  SerializedTimestamp,
  serializeTimestamp,
} from '@ledger-sync/core-integration-firebase'
import {makeSyncProvider} from '@ledger-sync/core-sync'
import {ledgerSyncProviderBase, makePostingsMap} from '@ledger-sync/ledger-sync'
import {
  A,
  compact,
  identity,
  Merge,
  objectFromArray,
  Rx,
  rxjs,
  z,
  zCast,
} from '@ledger-sync/util'
import {_parseAccounts, _parseConnectionInfo} from './foreceipt-utils'
import {
  ForeceiptClientOptions,
  makeForeceiptClient,
  zForeceiptConfig,
} from './ForeceiptClientNext'

type ForeceiptSyncOperation = typeof def['_opType']
const def = makeSyncProvider.def({
  ...ledgerSyncProviderBase.def,
  name: z.literal('foreceipt'),
  // integrationConfig: zForeceiptConfig,
  connectionSettings: z.object({
    credentials: zCast<Readonly<Foreceipt.Credentials>>(),
    options: zCast<ForeceiptClientOptions>(),
    _id: zCast<Id.external>(),
    envName: z.enum(['staging', 'production']),
  }),
  connectInput: zForeceiptConfig,
  connectOutput: zForeceiptConfig,
  sourceOutputEntity: z.discriminatedUnion('entityName', [
    z.object({
      id: z.string(),
      entityName: z.literal('account'),
      entity: zCast<Foreceipt.Account>(),
      info: zCast<ReturnType<typeof _parseConnectionInfo> | undefined>(),
    }),
    z.object({
      id: z.string(),
      entityName: z.literal('transaction'),
      entity: zCast<
        Merge<
          Foreceipt.Receipt,
          {
            create_time: SerializedTimestamp
            last_update_time: SerializedTimestamp
          }
        >
      >(),
      info: zCast<
        | ({_id?: Id.external} & ReturnType<typeof _parseConnectionInfo>)
        | undefined
      >(),
    }),
  ]),
})

export const foreceiptProvider = makeSyncProvider({
  ...ledgerSyncProviderBase(def, {
    sourceMapEntity: {
      account: ({entity: a}) => ({
        id: `${a.id}`,
        entityName: 'account',
        entity: identity<Standard.Account>({
          name: `FR ${a.name ?? ''}`,
          type: ((): Standard.AccountType => {
            switch (a.type) {
              case 'Cash':
                return 'asset/cash'
              case 'Chequing':
              case 'Saving':
              case 'Debit Card':
                return 'asset/bank'
              case 'Credit Card':
                return 'liability/credit_card'
              case 'Loan':
                return 'liability/personal_loan'
              default:
                return 'asset'
            }
          })(),
          defaultUnit: a.currency as Unit,
        }),
      }),
      transaction: ({entity, info, id}, _extConn) => {
        const t = entity.content
        const c = info
        const meta = entity
        const creator = c?.memberByGuid?.[meta.user_guid]
        return {
          id,
          entityName: 'transaction',
          entity: identity<Standard.Transaction>({
            date: t.receipt_date,
            payee: t.merchant,
            description: t.notes ?? '',
            // TODO: Split transactions should be handled via deleting one of the receipts in Alka
            removed: t.status === 'Deleted',
            postingsMap: makePostingsMap({
              main: {
                accountExternalId: `${c?._id}-${t.account_id}` as Id.external,
                amount: A(
                  (t.type === makeForeceiptClient(_extConn).EXPENSE_TYPE ||
                  t.type === makeForeceiptClient(_extConn).TRANSFER_TYPE
                    ? -1
                    : 1) * t.amount,
                  t.currency,
                ),
              },
              remainder: {
                accountExternalId:
                  t.type === makeForeceiptClient(_extConn).TRANSFER_TYPE
                    ? (`${c?._id}-${t.account1_id}` as Id.external)
                    : undefined,
                accountType: ((): Standard.AccountType => {
                  switch (t.type) {
                    case makeForeceiptClient(_extConn).EXPENSE_TYPE:
                      return 'expense'
                    case makeForeceiptClient(_extConn).INCOME_TYPE:
                      return 'income'
                    // eslint-disable-next-line unicorn/no-useless-switch-case
                    case makeForeceiptClient(_extConn).TRANSFER_TYPE:
                    default:
                      return 'equity/clearing'
                  }
                })(),
              },
            }),
            attachmentsMap: objectFromArray(
              t.image_file_list,
              (file) => file,
              (file) => ({
                url: `https://api.foreceipt.io/v1/receipt/image/${t.image_folder}/${file}`,
              }),
            ),
            labelsMap: {
              ...objectFromArray(
                t.tags ?? [],
                (tag) => tag,
                () => true,
              ),
              for_business: t.for_business ?? false, // Should this be label?
            },
            custom: {
              ...(c?.team && {
                created_by: compact([
                  creator?.first_name,
                  creator?.last_name,
                ]).join(' '),
              }),
            },
            externalCategory:
              c?.categoryNameById[
                compact([t.category_id, t.sub_category_id]).join('/')
              ],
          }),
        }
      },
    },
  }),
  // useConnectHook: (_type) => (_opts) =>
  //   new Deferred<typeof def['_types']['connectOutput']>().promise,

  // TODO: Need to check and fix the issue
  // postConnect: async (input, config) => {
  //   const settings = def._type('connectionSettings', {
  //     ...input,
  //   })
  //   const source$: rxjs.Observable<ForeceiptSyncOperation> =
  //     foreceiptProvider.sourceSync({settings, config, options: {}})

  //   return {
  //     connectionId: `conn_foreceipt_${input._id}`,
  //     settings,
  //     source$,
  //   }
  // },

  sourceSync: ({settings}) => {
    const client = makeForeceiptClient({...settings})
    const getInfo = client.getInfo
    let info: Awaited<ReturnType<typeof getInfo>> // Need this to handle only call one time promise

    const raw$ = rxjs.of(client.initFb()).pipe(
      Rx.mergeMap((fb) => {
        console.log(client.fbSettings, '===firebase init ===')
        return rxjs
          .from(client.getQuery$())
          .pipe(
            Rx.mergeMap((q) =>
              firebaseProvider.sourceSync({
                settings: client.fbSettings,
                options: {
                  _fb: fb,
                  _queries: Object.values(q),
                },
              }),
            ),
          )
          .pipe(
            Rx.mergeMap(async (op, i) => {
              if (!info && i === 0) {
                info = await getInfo()
              }
              const r =
                op.type === 'data' && op.data.entityName === 'Receipts'
                  ? (op.data.entity as Foreceipt.Receipt)
                  : null
              return op.type !== 'data'
                ? def._op('commit')
                : def._op('data', {
                    data:
                      op.data.entityName === 'Receipts'
                        ? {
                            id: r?.content.id ?? op.data.id,
                            entity: {
                              ...r,
                              _docId: op.data.id,
                              create_time: serializeTimestamp(
                                r?.create_time as FirebaseFirestore.Timestamp,
                              ),
                              last_update_time: serializeTimestamp(
                                r?.last_update_time as FirebaseFirestore.Timestamp,
                              ),
                            } as Foreceipt.Receipt,
                            entityName: 'transaction',
                            info,
                          }
                        : {
                            id: op.data.id,
                            entity: op.data.entity as Foreceipt.Account,
                            entityName: 'account',
                            info,
                          },
                  })
            }),
          )
      }),
    )

    return raw$.pipe(Rx.mergeMap((op) => rxjs.of(op)))
  },
})

import * as trpc from '@trpc/server'
import type {inferProcedureInput, inferProcedureOutput} from '@trpc/server'
import {TRPCError} from '@trpc/server'

import type {
  AnyEntityPayload,
  AnySyncProvider,
  ConnectionUpdate,
  ConnectWith,
  Destination,
  EnvName,
  Link,
  LinkFactory,
  MetaService,
  Source,
  UserId,
} from '@usevenice/cdk-core'
import {
  extractId,
  handlersLink,
  makeId,
  sync,
  zCheckConnectionOptions,
  zConnectOptions,
  zPostConnectOptions,
  zStandard,
  zWebhookInput,
} from '@usevenice/cdk-core'
import type {VeniceSourceState} from '@usevenice/cdk-ledger'
import {isZodType, joinPath, R, rxjs, z, zParser} from '@usevenice/util'

import type {ParseJwtPayload, UserInfo} from './auth-utils'
import {_zContext, makeJwtClient} from './auth-utils'
import {makeMetaLinks} from './makeMetaLinks'
import type {
  ConnectionInput,
  IntegrationInput,
  ParsedInt,
  ParsedPipeline,
  PipelineInput,
  ZInput,
} from './makeSyncParsers'
import {
  authorizeOrThrow,
  makeSyncParsers,
  zSyncOptions,
} from './makeSyncParsers'
import {parseWebhookRequest} from './parseWebhookRequest'

export {type inferProcedureInput} from '@trpc/server'

/** TODO: Use OpenApiMeta from https://github.com/jlalmes/trpc-openapi */
export interface EngineMeta {}

type _inferInput<T> = T extends z.ZodTypeAny ? z.input<T> : never
export interface SyncEngineConfig<
  TProviders extends readonly AnySyncProvider[],
  TLinks extends Record<string, LinkFactory>,
> {
  providers: TProviders
  /**
   * Base url of the engine-backend router when deployed, e.g. `localhost:3000/api/usevenice`
   * This is needed for 1) server side rendering and 2) webhook handling
   */
  apiUrl: string

  /** Used for oauth based connections */
  getRedirectUrl?: (integration: ParsedInt, ctx: {userId: UserId}) => string

  parseJwtPayload?: ParseJwtPayload

  // Backend only
  linkMap?: TLinks

  /** Used for authentication */
  jwtSecretOrPublicKey?: string

  /** Used to store metadata */
  metaService: MetaService
  getLinksForPipeline?: (pipeline: ParsedPipeline) => Link[]

  getDefaultPipeline?: (
    connInput?: ConnectionInput<TProviders[number]>,
    connectWith?: ConnectWith,
  ) => PipelineInput<TProviders[number], TProviders[number], TLinks>
  defaultIntegrations?:
    | Array<IntegrationInput<TProviders[number]>>
    | {
        [k in TProviders[number]['name']]?: _inferInput<
          Extract<TProviders[number], {name: k}>['def']['integrationConfig']
        >
      }
}

export type AnySyncRouter = ReturnType<typeof makeSyncEngine>['router']

export type AnySyncQueryInput<
  K extends keyof AnySyncRouter['_def']['queries'],
> = inferProcedureInput<AnySyncRouter['_def']['queries'][K]>
export type AnySyncQueryOutput<
  K extends keyof AnySyncRouter['_def']['queries'],
> = inferProcedureOutput<AnySyncRouter['_def']['queries'][K]>

export type AnySyncMutationInput<
  K extends keyof AnySyncRouter['_def']['mutations'],
> = inferProcedureInput<AnySyncRouter['_def']['mutations'][K]>
export type AnySyncMutationOutput<
  K extends keyof AnySyncRouter['_def']['mutations'],
> = inferProcedureOutput<AnySyncRouter['_def']['mutations'][K]>

export const baseRouter: typeof trpc.router<UserInfo, EngineMeta> = trpc.router

export const makeSyncEngine = <
  TProviders extends readonly AnySyncProvider[],
  TLinks extends Record<string, LinkFactory>,
>({
  metaService,
  providers,
  getDefaultPipeline,
  defaultIntegrations,
  getLinksForPipeline,
  jwtSecretOrPublicKey,
  parseJwtPayload,
  apiUrl,
  getRedirectUrl,
}: SyncEngineConfig<TProviders, TLinks>) => {
  // NEXT: Validate defaultDest and defaultIntegrations at init time rather than run time.
  const providerMap = R.mapToObj(providers, (p) => [p.name, p])
  const metaLinks = makeMetaLinks(metaService)

  // TODO: Re-enable me when providers are no longer being constructed client side...
  // Perhaps validating the default pipeline also
  const defaultIntegrationInputs = Array.isArray(defaultIntegrations)
    ? defaultIntegrations
    : R.toPairs(defaultIntegrations ?? {}).map(
        ([name, config]): IntegrationInput => ({
          id: makeId('int', name, ''), // This will end up with an ending `_` is it an issue?
          // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
          config: config as any,
        }),
      )
  /** getDefaultIntegrations will need to change to getIntegrations(forWorkspace) later  */
  const {zInt, zConn, zPipeline} = makeSyncParsers({
    providers,
    getDefaultPipeline,
    getDefaultConfig: (name, id) =>
      defaultIntegrationInputs.find(
        (i) => (id && i.id === id) || (i.id && extractId(i.id)[1] === name),
      )?.config,
    metaService,
  })

  const getDefaultIntegrations = async () =>
    Promise.all(
      defaultIntegrationInputs.map((input) =>
        zInt.parseAsync(input).catch((err) => {
          console.error('Error initialzing', input, err)
          throw new Error(`Error initializing integration ${input.id} `)
        }),
      ),
    )

  const getPipelinesForConnection = (
    connInput: ZInput['connection'],
    connectWith: ConnectWith | undefined,
  ) => {
    const defaultPipeline = () =>
      getDefaultPipeline?.(
        connInput as ConnectionInput<TProviders[number]>,
        connectWith,
      )

    // TODO: In the case of an existing `conn`, how do we update conn.settings too?
    // Otherwise we will result in outdated settings...
    return metaService
      .findPipelines({connectionIds: [connInput.id]})
      .then((pipes) => (pipes.length ? pipes : R.compact([defaultPipeline()])))
      .then((pipes) => Promise.all(pipes.map((p) => zPipeline.parseAsync(p))))
  }

  const _syncConnectionUpdate = async (
    int: ParsedInt,
    {
      userId,
      envName,
      settings,
      institution,
      ...connUpdate
    }: ConnectionUpdate<AnyEntityPayload, {}>,
  ) => {
    console.log('[_syncConnectionUpdate]', int.id, {
      userId,
      envName,
      settings,
      institution,
      ...connUpdate,
    })
    const id = makeId(
      'conn',
      int.provider.name,
      connUpdate.connectionExternalId,
    )
    await metaLinks
      .handlers({
        connection: {id, integrationId: int.id, creatorId: userId, envName},
      })
      .connUpdate({type: 'connUpdate', id, settings, institution})

    if (!connUpdate.source$ && !connUpdate.triggerDefaultSync) {
      return
    }

    const pipelines = await getPipelinesForConnection(
      {
        id,
        // Should we spread connUpdate into it?
        settings,
        creatorId: userId,
        // institution: connUpdate.institution,
      },
      connUpdate.connectWith ?? undefined,
    )

    console.log('_syncConnectionUpdate existingPipes.len', pipelines.length)
    await Promise.all(
      pipelines.map(async (pipe) => {
        await _syncPipeline(pipe, {
          source$: connUpdate.source$,
          source$ConcatDefault: connUpdate.triggerDefaultSync,
        })
      }),
    )
  }

  const _syncPipeline = async (
    pipeline: ParsedPipeline,
    opts: z.infer<typeof zSyncOptions> & {
      source$?: Source<AnyEntityPayload>
      /** Trigger the default sourceSync after source$ exhausts */
      source$ConcatDefault?: boolean
      destination$$?: Destination
    } = {},
  ) => {
    console.log('[syncPipeline]', pipeline)
    const {source: src, links, destination: dest, watch, ...pipe} = pipeline

    const defaultSource$ = () =>
      src.integration.provider.sourceSync?.({
        id: src.id,
        config: src.integration.config,
        settings: src.settings,
        // Maybe we should rename `options` to `state`?
        // Should also make the distinction between `config`, `settings` and `state` much more clear.
        // Undefined causes crash in Plaid provider due to destructuring, Think about how to fix it for reals
        state: opts.fullResync ? {} : pipe.sourceState,
      })

    const source$ = opts.source$
      ? opts.source$ConcatDefault
        ? rxjs.concat(opts.source$, defaultSource$() ?? rxjs.EMPTY)
        : opts.source$
      : defaultSource$()

    const destination$$ =
      opts.destination$$ ??
      dest.integration.provider.destinationSync?.({
        id: dest.id,
        config: dest.integration.config,
        settings: dest.settings,
        // Undefined causes crash in Plaid provider due to destructuring, Think about how to fix it for reals
        state: opts.fullResync ? {} : pipe.destinationState,
      })

    if (!source$) {
      throw new Error(`${src.integration.provider.name} missing source`)
    }
    if (!destination$$) {
      throw new Error(`${dest.integration.provider.name} missing destination`)
    }
    await metaLinks
      .handlers({pipeline})
      .stateUpdate({type: 'stateUpdate', subtype: 'init'})
    await sync({
      // Raw Source, may come from fs, firestore or postgres
      source: source$.pipe(
        // logLink({prefix: 'postSource', verbose: true}),
        metaLinks.postSource({src}),
      ),
      links: getLinksForPipeline?.(pipeline) ?? links,
      // WARNING: It is insanely unclear to me why moving `metaLinks.link`
      // to after provider.destinationSync makes all the difference.
      // When syncing from firebase with a large number of docs,
      // we always seem to stop after 1600 or so documents.
      // I already checked this is because metaLinks.link runs a async comment
      // even delay(100) introduces issues.
      // It's worth trying to reproduce this with say a simple counter source and see if
      // it happens...
      destination: rxjs.pipe(
        destination$$,
        metaLinks.postDestination({pipeline, dest}),
      ),
      watch,
    }).finally(() =>
      metaLinks
        .handlers({pipeline})
        .stateUpdate({type: 'stateUpdate', subtype: 'complete'}),
    )
  }

  const anonRouter = baseRouter()
    .query('health', {resolve: () => 'Ok ' + new Date().toISOString()})
    .mutation('handleWebhook', {
      input: z.tuple([zInt, zWebhookInput]),
      resolve: async ({input: [int, input]}) => {
        if (!int.provider.def.webhookInput || !int.provider.handleWebhook) {
          console.warn(`${int.provider.name} does not handle webhooks`)
          return
        }
        const res = await int.provider.handleWebhook(
          int.provider.def.webhookInput.parse(input),
          int.config,
        )
        await Promise.all(
          res.connectionUpdates.map((connUpdate) =>
            // Provider is responsible for providing envName / userId
            // TODO: Should provider be responsible for providing connectWith?
            // This may be relevant for OneBrick connections for example
            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
            _syncConnectionUpdate(int, connUpdate),
          ),
        )

        return res.response?.body
      },
    })

  const authenticatedRouter = baseRouter()
    .middleware(({next, ctx, path}) => {
      if (!ctx.userId) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: `Auth required: ${path}`,
        })
      }
      // Figure out how we can pass the context into zod validators so that we can
      // check user has access to connection pipline etc in a single place...
      // Also we probably don't want non-admin user to be able to provider anything
      // other than the `id` for integration, connection and pipeline
      return next({ctx: {...ctx, userId: ctx.userId}})
    })
    // MARK: - Metadata  etc
    .query('listIntegrations', {
      input: z.object({type: z.enum(['source', 'destination']).nullish()}),
      resolve: async ({input: {type}}) => {
        const ints = await getDefaultIntegrations()
        return ints
          .map((int) => ({
            id: int.id,
            isSource: !!int.provider.sourceSync,
            isDestination: !!int.provider.destinationSync,
          }))
          .filter(
            (int) =>
              !type ||
              (type === 'source' && int.isSource) ||
              (type === 'destination' && int.isDestination),
          )
      },
    })
    .query('searchInstitutions', {
      input: z.object({keywords: z.string().trim().nullish()}).optional(),
      resolve: async ({input: {keywords} = {}}) => {
        const ints = await getDefaultIntegrations()
        const institutions = await metaService.searchInstitutions({
          keywords,
          limit: 10,
          providerNames: R.uniq(ints.map((int) => int.provider.name)),
        })
        const intsByProviderName = R.groupBy(ints, (int) => int.provider.name)
        return institutions.flatMap((ins) => {
          const [, providerName, externalId] = extractId(ins.id)
          const standard = providerMap[
            providerName
          ]?.standardMappers?.institution?.(ins.external)
          const res = zStandard.institution.omit({id: true}).safeParse(standard)

          if (!res.success) {
            console.error('Invalid institution found', ins, res.error)
            return []
          }
          return (intsByProviderName[providerName] ?? []).map((int) => ({
            ins: {...res.data, id: ins.id, externalId},
            int: {id: int.id},
          }))
        })
      },
    })
    .query('listConnections', {
      input: z.object({}).optional(),
      resolve: async ({ctx}) => {
        // Add info about what it takes to `reconnect` here for connections which
        // has disconnected
        const connections = await metaService.tables.connection.list({
          creatorId: ctx.userId,
        })
        const insById = R.pipe(
          await metaService.tables.institution.list({
            ids: R.compact(connections.map((c) => c.institutionId)),
          }),
          (insList) => R.mapToObj(insList, (ins) => [ins.id, ins]),
        )
        const pipelinesByConnId = R.pipe(
          await metaService.findPipelines({
            connectionIds: connections.map((c) => c.id),
          }),
          R.map((pipe) => ({
            ...pipe,
            syncInProgress:
              (pipe.lastSyncStartedAt && !pipe.lastSyncCompletedAt) ||
              (pipe.lastSyncStartedAt &&
                pipe.lastSyncCompletedAt &&
                pipe.lastSyncStartedAt > pipe.lastSyncCompletedAt),
          })),
          (pipes) =>
            R.mapToObj(connections, (c) => [
              c.id,
              pipes.filter(
                (p) => p.sourceId === c.id || p.destinationId === c.id,
              ),
            ]),
        )
        return connections.map((conn) => {
          const [, providerName, externalId] = extractId(conn.id)
          const mappers = providerMap[providerName]?.standardMappers
          const standardConn = mappers?.connection(conn.settings)
          const standardIns = conn.institutionId
            ? mappers?.institution?.(insById[conn.institutionId]?.external)
            : undefined

          const pipes = pipelinesByConnId[conn.id] ?? []
          const syncInProgress = pipes.some((p) => p.syncInProgress)
          const lastSyncCompletedAt = R.maxBy(
            pipes,
            (p) => p.lastSyncCompletedAt?.getTime() ?? 0,
          )?.lastSyncCompletedAt

          // console.log('map connection', {
          //   conn,
          //   standardConn,
          //   standardIns,
          //   syncInProgress,
          //   'pipelinesByConnId[conn.id]': pipelinesByConnId[conn.id],
          // })

          return {
            // TODO: How do we get zod to report which specific object has failed parsing?
            // This error for example is cryptic, https://share.cleanshot.com/t1QY1mnG
            // I would really like to know that it is zStandard.connection that has failed parsing
            ...zStandard.connection.omit({id: true}).parse(standardConn),
            id: conn.id,
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
            envName: conn.envName as EnvName | null | undefined,
            externalId,
            syncInProgress,
            lastSyncCompletedAt,
            institution: conn.institutionId
              ? {
                  ...zStandard.institution.omit({id: true}).parse(standardIns),
                  id: conn.institutionId,
                }
              : undefined,
          }
        })
      },
    })
    // TODO: Do we need this method at all? Or should we simply add params to args
    // to syncConnection instead? For example, skipPipelines?
    .mutation('checkConnection', {
      meta: {
        description: 'Not automatically called, used for debugging for now',
      },
      input: z.tuple([zConn, zCheckConnectionOptions.optional()]),
      resolve: async ({
        input: [{settings, integration: int, ...conn}, opts],
        ctx,
      }) => {
        authorizeOrThrow(ctx, 'connection', conn)
        // console.log('checkConnection', {settings, integration, ...conn}, opts)
        const connUpdate = await int.provider.checkConnection?.({
          settings,
          config: int.config,
          options: opts ?? {},
          context: {
            webhookBaseUrl: joinPath(
              apiUrl,
              parseWebhookRequest.pathOf(int.id),
            ),
          },
        })
        if (connUpdate || opts?.import) {
          /** Do not update the `creatorId` here... */
          await _syncConnectionUpdate(int, {
            ...(opts?.import && {
              userId: conn.creatorId ?? undefined,
              envName: conn.envName ?? undefined,
            }),
            ...connUpdate,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            settings: {...(opts?.import && settings), ...connUpdate?.settings},
            connectionExternalId:
              connUpdate?.connectionExternalId ?? extractId(conn.id)[2],
            connectWith: opts?.connectWith,
          })
        }
        if (!int.provider.checkConnection) {
          return `Not implemented in ${int.provider.name}`
        }
        return 'Ok'
      },
    })
    // What about delete? Should this delete also? Or soft delete?
    .mutation('deleteConnection', {
      input: z.tuple([
        zConn,
        z.object({revokeOnly: z.boolean().nullish()}).optional(),
      ]),
      resolve: async ({
        input: [{settings, integration, ...conn}, opts],
        ctx,
      }) => {
        authorizeOrThrow(ctx, 'connection', conn)
        await integration.provider.revokeConnection?.(
          settings,
          integration.config,
        )
        if (opts?.revokeOnly) {
          return
        }
        await metaService.tables.connection.delete(conn.id)
      },
    })
    // MARK: - Connect
    .mutation('preConnect', {
      input: z.tuple([zInt, zConnectOptions]),
      // Consider using sessionId, so preConnect corresponds 1:1 with postConnect
      resolve: async ({
        input: [int, {connectionExternalId, ...connCtxInput}],
        ctx,
      }) => {
        const conn = connectionExternalId
          ? await metaService.tables.connection
              .get(makeId('conn', int.provider.name, connectionExternalId))
              .then((input) => zConn.parseAsync(input))
          : undefined
        authorizeOrThrow(ctx, 'connection', conn)
        return int.provider.preConnect?.(int.config, {
          ...connCtxInput,
          userId: ctx.userId,
          connection: conn
            ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              {externalId: connectionExternalId!, settings: conn.settings}
            : undefined,
          webhookBaseUrl: joinPath(apiUrl, parseWebhookRequest.pathOf(int.id)),
          redirectUrl: getRedirectUrl?.(int, ctx),
        })
      },
    })
    // useConnectHook happens client side only
    // for cli usage, can just call `postConnect` directly. Consider making the
    // flow a bit smoother with a guided cli flow
    .mutation('postConnect', {
      // Questionable why `zConnectContextInput` should be there. Examine whether this is actually
      // needed
      input: z.tuple([z.unknown(), zInt, zPostConnectOptions]),
      // How do we verify that the userId here is the same as the userId from preConnectOption?
      resolve: async ({
        input: [input, int, {connectionExternalId, ...connCtxInput}],
        ctx,
      }) => {
        console.log('didConnect start', int.provider.name, input, connCtxInput)
        if (!int.provider.postConnect || !int.provider.def.connectOutput) {
          return 'Noop'
        }
        const conn = connectionExternalId
          ? await metaService.tables.connection
              .get(makeId('conn', int.provider.name, connectionExternalId))
              .then((input) => zConn.parseAsync(input))
          : undefined
        authorizeOrThrow(ctx, 'connection', conn)

        const connUpdate = await int.provider.postConnect(
          int.provider.def.connectOutput.parse(input),
          int.config,
          {
            ...connCtxInput,
            userId: ctx.userId,
            connection: conn
              ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                {externalId: connectionExternalId!, settings: conn.settings}
              : undefined,
            webhookBaseUrl: joinPath(
              apiUrl,
              parseWebhookRequest.pathOf(int.id),
            ),
            redirectUrl: getRedirectUrl?.(int, ctx),
          },
        )
        await _syncConnectionUpdate(int, {
          ...connUpdate,
          // No need for each integration to worry about this, unlike in the case of handleWebhook.
          userId: ctx.userId,
          envName: connCtxInput.envName,
          connectWith: connCtxInput.connectWith,
        })
        console.log('didConnect finish', int.provider.name, input)
        return 'Connection Success'
      },
    })

    // MARK: - Sync
    .mutation('syncConnection', {
      input: z.tuple([zConn, zSyncOptions.optional()]),
      resolve: async function syncConnection({input: [conn, opts], ctx}) {
        authorizeOrThrow(ctx, 'connection', conn)
        console.log('[syncConnection]', conn, opts)
        // No need to checkConnection here as sourceSync should take care of it

        if (opts?.metaOnly) {
          await sync({
            source:
              conn.integration.provider.sourceSync?.({
                id: conn.id,
                config: conn.integration.config,
                settings: conn.settings,
                // Maybe we should rename `options` to `state`?
                // Should also make the distinction between `config`, `settings` and `state` much more clear.
                // Undefined causes crash in Plaid provider due to destructuring, Think about how to fix it for reals
                state: R.identity<VeniceSourceState>({
                  streams: ['connection', 'institution'],
                }),
              }) ?? rxjs.EMPTY,
            destination: metaLinks.postSource({src: conn}),
          })
          return
        }

        // TODO: Figure how to handle situations where connection does not exist yet
        // but pipeline is already being persisted properly. This current solution
        // is vulnerable to race condition and feels brittle. Though syncConnection is only
        // called from the UI so we are fine for now.
        await _syncConnectionUpdate(conn.integration, {
          userId: ctx.userId,
          settings: conn.settings,
          // What about envName
          connectionExternalId: extractId(conn.id)[2],
          institution: conn.institution && {
            id: conn.institution.id,
            data: conn.institution.external ?? {},
          },
          connectWith: opts?.connectWith,
        })
      },
    })
    .mutation('syncPipeline', {
      input: z.tuple([zPipeline, zSyncOptions.optional()]),
      resolve: async function syncPipeline({input: [pipeline, opts], ctx}) {
        console.log('[syncPipeline]', pipeline)
        authorizeOrThrow(ctx, 'pipeline', pipeline)
        return _syncPipeline(pipeline, opts)
      },
    })

  const adminRouter = baseRouter()
    .middleware(({next, ctx, path}) => {
      if (!ctx.isAdmin) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: `Admin only: ${path}`,
        })
      }
      return next({ctx: {...ctx, isAdmin: true as const}})
    })
    // .query('adminDebugEnv', {resolve: () => process.env}) // Temporary...
    .query('adminSearchCreatorIds', {
      input: z.object({keywords: z.string().trim().nullish()}).optional(),
      resolve: async ({input: {keywords} = {}}) =>
        metaService.searchCreatorIds({keywords}),
    })
    .query('adminGetIntegration', {
      input: zInt,
      resolve: ({input: int}) => ({
        config: int.config,
        provider: int.provider.name,
        id: int.id,
      }),
    })
    .mutation('adminSyncMetadata', {
      input: zInt.nullish(),
      resolve: async ({input: int}) => {
        const ints = int ? [int] : await getDefaultIntegrations()
        const stats = await sync({
          source: rxjs.merge(
            ...ints.map(
              (int) =>
                int.provider.metaSync?.({config: int.config}).pipe(
                  handlersLink({
                    data: (op) =>
                      rxjs.of({
                        ...op,
                        data: {
                          ...op.data,
                          entity: {
                            external: op.data.entity as unknown,
                            standard:
                              int.provider.standardMappers?.institution?.(
                                op.data.entity,
                              ),
                          },
                        },
                      }),
                  }),
                ) ?? rxjs.EMPTY,
            ),
          ),
          // This single destination is a bottleneck to us removing
          // prefixed ids from protocol itself
          destination: metaLinks.persistInstitution(),
        })
        return `Synced ${stats} institutions from ${ints.length} providers`
      },
    })

  const router = baseRouter()
    .merge(anonRouter)
    .merge(authenticatedRouter)
    .merge(adminRouter)

  const jwtClient = jwtSecretOrPublicKey
    ? makeJwtClient({secretOrPublicKey: jwtSecretOrPublicKey})
    : undefined

  const zContext = _zContext({
    parseJwtToken: jwtClient ? jwtClient.verify : undefined,
    parseJwtPayload,
  })

  // Improve the error generated by zod
  // TODO: Move me into a generic location...
  for (const key of ['queries', 'mutations', 'subscriptions'] as const) {
    for (const [name, val] of Object.entries(router._def[key])) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const inputParser: unknown = val.inputParser
      if (isZodType(inputParser)) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        val.parseInputFn = zParser(
          inputParser.describe(`${key}.${name}.input`),
        ).parseAsync
      }
    }
  }

  return {router, jwtClient, zContext}
}

/** Only purpose of this is to support type inference */
makeSyncEngine.config = <
  TProviders extends readonly AnySyncProvider[],
  TLinks extends Record<string, LinkFactory>,
>(
  config: SyncEngineConfig<TProviders, TLinks>,
) => config

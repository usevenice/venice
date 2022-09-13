import OpenAPIClientAxios from 'openapi-client-axios'

import {
  $makeProxyAgent,
  getDefaultProxyAgent,
  stringifyQueryParams,
  z,
  zFunction,
} from '@ledger-sync/util'

import type {Client as YodleeClient} from './client'

const zFetcherConfig = z.object({
  proxy: z.object({url: z.string(), cert: z.string()}).nullish(),
  clientId: z.string(),
  clientSecret: z.string(),
  url: z.string(),
})

// Please consider this is as a new type gen since openapi-typescript have a similiar issue with this because of node-fetch https://github.com/nock/nock/issues/2197
// References: https://github.com/anttiviljami/openapi-client-axios/blob/master/DOCS.md
// TODO: Will move this entire function to YodleeClient once it finished and tested
export const createFetcher = zFunction(
  zFetcherConfig,
  ({proxy, clientId, clientSecret, url}) => {
    const createClientInstance = async (
      accessToken?: string,
      loginName?: string,
    ): Promise<YodleeClient> => {
      const headers = {
        'cache-control': 'no-cache',
        'Api-Version': '1.1',
      }

      const additionalHeaders = accessToken
        ? {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          }
        : {
            loginName,
          }

      const api = new OpenAPIClientAxios({
        definition: './packages/@integrations/integration-yodlee/yodlee.yaml',
        withServer: {url},
        axiosConfigDefaults: {
          withCredentials: true,
          httpsAgent:
            getDefaultProxyAgent() ?? (proxy && $makeProxyAgent(proxy)),
          headers: {
            ...headers,
            ...additionalHeaders,
          },
        },
      })

      return await api.getClient<YodleeClient>()
    }
    const generateAccessToken = async (loginName: string) => {
      const client = await createClientInstance(undefined, loginName)
      const accesssToken = client.paths['/auth/token'].post(
        null,
        stringifyQueryParams({clientId, secret: clientSecret}),
      )

      return (await accesssToken).data.token?.accessToken
    }

    return {
      generateAccessToken: zFunction(z.string(), (loginName) =>
        generateAccessToken(loginName),
      ),
      getProvider: zFunction(
        [z.number(), z.string()],
        async (providerId, accessToken) => {
          const client = await createClientInstance(accessToken)
          return client.paths['/providers/{providerId}'].get({providerId})
        },
      ),
      getUser: zFunction(z.string(), async (accesssToken) => {
        const client = await createClientInstance(accesssToken)
        return client.paths['/user'].get()
      }),
    }
  },
)

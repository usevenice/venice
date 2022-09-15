import * as jwt from 'jsonwebtoken'
import {TRPCError} from '@trpc/server'

import {zId} from '@ledger-sync/cdk-core'
import {z, zFunction, zGuard} from '@ledger-sync/util'

export type UserInfo = z.infer<typeof _zUserInfo>
const _zUserInfo = z.object({
  ledgerId: zId('ldgr').nullish(),
  isAdmin: z.boolean().nullish(),
})

export type ParseJwtPayload = (jwtPayload: jwt.JwtPayload) => UserInfo

export const zUserInfo = (options: {
  /** If undefined, will use jwtDecode */
  parseJwtToken?: (token: string) => jwt.JwtPayload
  parseJwtPayload?: ParseJwtPayload
}) => {
  const parseJwtToken =
    options.parseJwtToken ?? ((token) => jwt.decode(token, {json: true}))

  const parseJwtPayload =
    options.parseJwtPayload ??
    ((jwt) => ({
      ledgerId: jwt.sub,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/dot-notation
      isAdmin: jwt['user_metadata']?.['isAdmin'] === true,
    }))

  // Still need to return userId... JWT decode?
  // console.log('createEngineContext', config, ctxInput)

  return z
    .string()
    .nullish()
    .transform(
      zGuard((token) => {
        const payload = token ? parseJwtToken(token) : undefined
        const userInfo = parseJwtPayload(payload ?? {})
        return _zUserInfo.parse(userInfo)
      }),
    )
}

export const makeJwtClient = zFunction(
  z.object({secretOrPublicKey: z.string()}),
  ({secretOrPublicKey}) => ({
    verify: (token: string) => {
      try {
        const data = jwt.verify(token, secretOrPublicKey)
        if (typeof data === 'string') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Unexpected jwt data',
          })
        }
        return data
      } catch (err) {
        // This dependency is not great... But don't know of a better pattern for now
        throw new TRPCError({code: 'UNAUTHORIZED', message: `${err}`})
      }
    },
    decode: (token: string) => jwt.decode(token),
    sign: (payload: jwt.JwtPayload) => jwt.sign(payload, secretOrPublicKey),
  }),
)

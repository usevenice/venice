const path = require('node:path')
const webpack = require('webpack')
// prettier-ignore
const withTM = require('next-transpile-modules')([
  path.resolve(__dirname, '../app-config'),
  path.resolve(__dirname, '../../packages/@integrations/core-integration-airtable'),
  path.resolve(__dirname, '../../packages/@integrations/core-integration-firebase'),
  path.resolve(__dirname, '../../packages/@integrations/core-integration-fs'),
  path.resolve(__dirname, '../../packages/@integrations/core-integration-mongodb'),
  path.resolve(__dirname, '../../packages/@integrations/core-integration-postgres'),
  path.resolve(__dirname, '../../packages/@integrations/core-integration-redis'),
  path.resolve(__dirname, '../../packages/@integrations/integration-beancount'),
  path.resolve(__dirname, '../../packages/@integrations/integration-foreceipt'),
  path.resolve(__dirname, '../../packages/@integrations/integration-import'),
  path.resolve(__dirname, '../../packages/@integrations/integration-onebrick'),
  path.resolve(__dirname, '../../packages/@integrations/integration-plaid'),
  path.resolve(__dirname, '../../packages/@integrations/integration-postgres'),
  path.resolve(__dirname, '../../packages/@integrations/integration-ramp'),
  path.resolve(__dirname, '../../packages/@integrations/integration-splitwise'),
  path.resolve(__dirname, '../../packages/@integrations/integration-stripe'),
  path.resolve(__dirname, '../../packages/@integrations/integration-teller'),
  path.resolve(__dirname, '../../packages/@integrations/integration-toggl'),
  path.resolve(__dirname, '../../packages/@integrations/integration-wise'),
  path.resolve(__dirname, '../../packages/@integrations/integration-yodlee'),
  path.resolve(__dirname, '../../packages/@utils/accounting'),
  path.resolve(__dirname, '../../packages/@utils/id'),
  path.resolve(__dirname, '../../packages/@utils/standard'),
  path.resolve(__dirname, '../../packages/@utils/util'),
  path.resolve(__dirname, '../../packages/cdk-core'),
  path.resolve(__dirname, '../../packages/cdk-ledger'),
  path.resolve(__dirname, '../../packages/engine-common'),
  path.resolve(__dirname, '../../packages/engine-backend'),
  path.resolve(__dirname, '../../packages/engine-frontend'),
])

/**
 * @type {import('next').NextConfig}
 */
module.exports = withTM(
  /** @type {import('next').NextConfig} */ ({
    reactStrictMode: true,
    swcMinify: true,
    typescript: {
      ignoreBuildErrors: true,
    },
    eslint: {
      ignoreDuringBuilds: true,
    },
    experimental: {
      esmExternals: false,
      newNextLinkBehavior: true,
    },
    webpack: (config) => {
      config.module.exprContextCritical = false
      config.module.unknownContextCritical = false
      config.module.rules.push({
        test: /\.node$/,
        use: [{loader: 'node-loader'}],
      })
      config.resolve.fallback = {
        fs: false,
        child_process: false, // Reference: https://stackoverflow.com/questions/54459442/module-not-found-error-cant-resolve-child-process-how-to-fix
        // For mongodb, Refs: https://stackoverflow.com/questions/54275069/module-not-found-error-cant-resolve-net-in-node-modules-stompjs-lib
        tls: false,
        net: false,
        dns: false,
      }
      config.plugins.push(
        new webpack.IgnorePlugin({
          resourceRegExp:
            /^(encoding|bson-ext|kerberos|@mongodb-js\/zstd|snappy|snappy\/package\.json|aws4|mongodb-client-encryption)$/,
        }),
      )
      return config
    },
    images: {
      domains: ['yodlee-1.hs.llnwd.net'],
    },
  }),
)

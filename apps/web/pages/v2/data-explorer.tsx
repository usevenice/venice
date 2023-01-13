import type {GridCell, GridColumn, Item} from '@glideapps/glide-data-grid'
import {GridCellKind} from '@glideapps/glide-data-grid'
import {Auth} from '@supabase/auth-ui-react'
import dynamic from 'next/dynamic'
import React, {useState} from 'react'
import {useSelect} from 'react-supabase'

import {Container} from '@usevenice/ui'
import {produce} from '@usevenice/util'

import {Layout} from '../../components/Layout'
import {useRouterPlus} from '../../contexts/atoms'

import '@glideapps/glide-data-grid/dist/index.css'

import {VeniceProvider} from '@usevenice/engine-frontend'

const DataEditor = dynamic(
  () => import('@glideapps/glide-data-grid').then((r) => r.DataEditor),
  {ssr: false},
)

export default function DataExplorerScreen() {
  const {user} = Auth.useUser()

  const {trpcClient} = VeniceProvider.useContext()

  const [connsRes] = useSelect('connection')
  console.log('conns', connsRes.data)

  const [pipesRes] = useSelect('pipeline')
  console.log('pipes', pipesRes.data)

  const [accountsRes] = useSelect('account')
  console.log('accounts', accountsRes.data)

  // const [transactionsRes] = useSelect('transaction')
  // console.log('transactions', transactionsRes.data)

  // Grid columns may also provide icon, overlayIcon, menu, style, and theme overrides
  const [columns, setColumns] = React.useState([
    {id: 'id', title: 'Id', width: 100},
    {id: 'provider_name', title: 'Provider Name', width: 100},
  ] as GridColumn[])

  // If fetching data is slow you can use the DataEditor ref to send updates for cells
  // once data is loaded.

  const items = accountsRes.data ?? []
  function getData([colIdx, rowIdx]: Item): GridCell {
    const col = columns[colIdx]!
    const row = items[rowIdx]!
    return {
      kind: GridCellKind.Text,
      data: row[col.id!] ?? '<empty>',
      allowOverlay: false,
      displayData: row[col.id!] ?? '<empty>',
    }
  }

  // if (!user) {
  //   return (
  //     <EffectContainer effect={() => void router.pushPathname('/v2/auth')}>
  //       <Layout>
  //         <Container className="flex-1">
  //           <Loading />
  //         </Container>
  //       </Layout>
  //     </EffectContainer>
  //   )
  // }

  const [sql, setSql] = useState('')

  return (
    <Layout
      links={[
        {label: 'Connections', href: '/v2/connections'},
        {label: 'Data explorer', href: '/v2/data-explorer'},
      ]}>
      <Container className="flex-1">
        <span className="text-xs">You are logged in as {user?.id}</span>
        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}></textarea>
        <button
          onClick={async () => {
            // @ts-expect-error
            const res = await trpcClient.mutation('executeSql', {sql})
            console.log('executeSql result', res)
          }}>
          Execute SQL
        </button>
        <button
          onClick={async () => {
            // @ts-expect-error
            const res = await trpcClient.mutation('createDbUser', {})
            console.log('executeSql result', res)
          }}>
          create db user
        </button>
        Connections
        <ul>
          {connsRes.data?.map((conn) => (
            <li key={conn.id}>{conn.id}</li>
          ))}
        </ul>
        Pipelines
        <ul>
          {pipesRes.data?.map((pipe) => (
            <li key={pipe.id}>{pipe.id}</li>
          ))}
        </ul>
        <DataEditor
          getCellContent={getData}
          columns={columns}
          rows={items.length}
          onColumnResize={(col, newSize) => {
            console.log('col resize', col, newSize)
            setColumns((existing) =>
              produce(existing, (draft) => {
                const c = draft.find((c) => c.id === col.id)
                if (c) {
                  // @ts-expect-error
                  c.width = newSize
                }
              }),
            )
          }}
        />
      </Container>
    </Layout>
  )
}

'use client'

// Offline-first customers list (Task 16). Renders from the local Dexie
// cache immediately; the network delta pull is a background enhancement
// that never blocks the initial render ("no spinner may ever block on
// network for cached data").
//
// OfflineDb is constructed inside useEffect, not at module scope: its
// constructor touches the global `indexedDB` object and throws immediately
// if it's missing — which it is during `next build`'s server-side prerender
// pass for this 'use client' page (see lib/offline/db.ts).
import { useEffect, useState } from 'react'
import { OfflineDb, type CustomerRecord } from '@/lib/offline/db'
import { pullDelta } from '@/lib/offline/sync-client'

export default function CustomersPage() {
  const [customers, setCustomers] = useState<CustomerRecord[]>([])

  useEffect(() => {
    const db = new OfflineDb()

    db.customers.toArray().then(setCustomers)

    if (navigator.onLine) {
      // tenantId is derived server-side from the session (Task 16b) — the
      // client no longer supplies one.
      pullDelta(db, { sinceCursor: '0' }).then(() => {
        db.customers.toArray().then(setCustomers)
      })
    }
  }, [])

  return (
    <ul>
      {customers.map((c) => (
        <li key={c.id}>{c.name}</li>
      ))}
    </ul>
  )
}

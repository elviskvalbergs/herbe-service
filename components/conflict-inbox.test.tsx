import { describe, expect, it, vi } from 'vitest'
import type { InboxItem } from '@/lib/inbox/get-inbox-items'

// `ConflictInbox` (default export) is a 'use client' component using
// `useState`/`useRouter` — hooks require an active React renderer, which
// this project's Vitest setup doesn't have (no jsdom/@testing-library — see
// app/layout.test.tsx's comments for the underlying constraint).
// `ConflictInboxList` is a plain function with no hooks, extracted
// specifically so it stays unit-testable without one (same pattern as
// components/sync-status-chip.tsx's deriveSyncStatus / SyncStatusChip
// split).
//
// Merely importing the module still evaluates next/navigation's barrel
// export, which crashes under this project's forced 'react-server' resolve
// condition (see components/locale-switcher.test.ts) — stubbed here purely
// to make the module loadable.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

import { ConflictInboxList } from './conflict-inbox'

type El<P> = { type: unknown; key: unknown; props: P }

const items: InboxItem[] = [
  {
    id: 'op-1',
    entity: 'serviceOrder',
    op: 'create',
    errorMessage: 'ERP timeout',
    createdAt: new Date('2026-07-01T12:00:00.000Z'),
  },
  {
    id: 'op-2',
    entity: 'serviceOrder',
    op: 'create',
    errorMessage: null,
    createdAt: new Date('2026-07-02T12:00:00.000Z'),
  },
]

describe('ConflictInboxList', () => {
  it('renders the empty state when there are no failed ops', () => {
    const element = ConflictInboxList({ items: [], onRetry: vi.fn(), retryingId: null, retryError: null }) as El<{
      children: string
    }>

    expect(element.type).toBe('p')
    expect(element.props.children).toBe('No conflicts.')
  })

  it('renders one row per item with entity, op, timestamp, and error message', () => {
    const element = ConflictInboxList({ items, onRetry: vi.fn(), retryingId: null, retryError: null }) as El<{
      children: El<{ children: unknown[] }>[]
    }>

    expect(element.type).toBe('ul')
    const rows = element.props.children
    expect(rows).toHaveLength(2)

    const [row0, row1] = rows
    expect(row0.key).toBe('op-1')
    expect(row1.key).toBe('op-2')

    const headerRow0 = row0.props.children[0] as El<{ children: El<{ children: unknown }>[] }>
    const [entityOpSpan, timestampSpan] = headerRow0.props.children
    expect(entityOpSpan.props.children).toEqual(['serviceOrder', ' · ', 'create'])
    expect(timestampSpan.props.children).toBe(items[0].createdAt.toLocaleString())

    const errorParagraph = row0.props.children[1] as El<{ children: string }>
    expect(errorParagraph.props.children).toBe('ERP timeout')

    // op-2 has no errorMessage — that slot renders nothing.
    expect(row1.props.children[1]).toBeNull()
  })

  it('shows the retry button, enabled and labeled "Retry", when not in flight', () => {
    const element = ConflictInboxList({ items, onRetry: vi.fn(), retryingId: null, retryError: null }) as El<{
      children: El<{ children: unknown[] }>[]
    }>

    const li = element.props.children[0]
    const button = li.props.children[2] as El<{ disabled: boolean; children: string; onClick: () => void }>

    expect(button.props.disabled).toBe(false)
    expect(button.props.children).toBe('Retry')
  })

  it('calls onRetry with the item id when its retry button is clicked', () => {
    const onRetry = vi.fn()
    const element = ConflictInboxList({ items, onRetry, retryingId: null, retryError: null }) as El<{
      children: El<{ children: unknown[] }>[]
    }>

    const li = element.props.children[1]
    const button = li.props.children[2] as El<{ onClick: () => void }>
    button.props.onClick()

    expect(onRetry).toHaveBeenCalledWith('op-2')
  })

  it('disables the retry button and labels it "Retrying…" for the in-flight item only', () => {
    const element = ConflictInboxList({ items, onRetry: vi.fn(), retryingId: 'op-1', retryError: null }) as El<{
      children: El<{ children: unknown[] }>[]
    }>

    const retryingLi = element.props.children[0]
    const retryingButton = retryingLi.props.children[2] as El<{ disabled: boolean; children: string }>
    expect(retryingButton.props.disabled).toBe(true)
    expect(retryingButton.props.children).toBe('Retrying…')

    const otherLi = element.props.children[1]
    const otherButton = otherLi.props.children[2] as El<{ disabled: boolean; children: string }>
    expect(otherButton.props.disabled).toBe(false)
    expect(otherButton.props.children).toBe('Retry')
  })

  it('shows a "Retry failed" message only for the item the error belongs to', () => {
    const element = ConflictInboxList({
      items,
      onRetry: vi.fn(),
      retryingId: null,
      retryError: { id: 'op-2', message: 'network error' },
    }) as El<{ children: El<{ children: unknown[] }>[] }>

    const erroredLi = element.props.children[1]
    const errorParagraph = erroredLi.props.children[3] as El<{ children: unknown[] }>
    expect(errorParagraph.props.children).toEqual(['Retry failed: ', 'network error'])

    const otherLi = element.props.children[0]
    // op-1 has its own sync errorMessage but no retryError, so its extra slot is null.
    expect(otherLi.props.children[3]).toBeNull()
  })
})

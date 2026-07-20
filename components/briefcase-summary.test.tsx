import { describe, expect, it } from 'vitest'
import { BriefcaseSummary, type BriefcaseBucket } from './briefcase-summary'

type El<P> = { type: unknown; props: P }

describe('BriefcaseSummary', () => {
  it('renders an empty state when the buckets array is empty', () => {
    const element = BriefcaseSummary({ buckets: [] }) as El<{ children: string }>

    expect(element.type).toBe('p')
    expect(element.props.children).toBe('Your briefcase is empty.')
  })

  it('renders an empty state when every bucket count is zero', () => {
    const buckets: BriefcaseBucket[] = [
      { label: 'Assigned to you', count: 0 },
      { label: 'Pending sync', count: 0 },
    ]

    const element = BriefcaseSummary({ buckets }) as El<{ children: string }>

    expect(element.type).toBe('p')
    expect(element.props.children).toBe('Your briefcase is empty.')
  })

  it('renders one row per bucket when at least one has a non-zero count', () => {
    const buckets: BriefcaseBucket[] = [
      { label: 'Assigned to you', count: 3 },
      { label: 'Pending sync', count: 0 },
    ]

    const element = BriefcaseSummary({ buckets }) as El<{
      children: El<{ children: [El<{ children: string }>, El<{ children: string }>] }>[]
    }>

    expect(element.type).toBe('ul')
    const rows = element.props.children
    expect(rows).toHaveLength(2)

    const [label0, count0] = rows[0].props.children
    expect(label0.props.children).toBe('Assigned to you')
    expect(count0.props.children).toEqual([3, ''])

    const [label1, count1] = rows[1].props.children
    expect(label1.props.children).toBe('Pending sync')
    expect(count1.props.children).toEqual([0, ''])
  })

  it('appends the lastSyncedAt time to a bucket that has one', () => {
    const syncedAt = new Date('2026-07-01T12:00:00.000Z')
    const buckets: BriefcaseBucket[] = [{ label: 'Cached customers', count: 5, lastSyncedAt: syncedAt }]

    const element = BriefcaseSummary({ buckets }) as El<{
      children: El<{ children: [El<{ children: string }>, El<{ children: string }>] }>[]
    }>

    const [, count] = element.props.children[0].props.children
    expect(count.props.children).toEqual([5, ` · synced ${syncedAt.toLocaleString()}`])
  })
})

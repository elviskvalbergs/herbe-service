import { describe, expect, it, vi } from 'vitest'

// `CompanySwitcher` has no hooks of its own, but it renders next/link's
// `Link`, whose module crashes on import under this project's forced
// 'react-server' resolve condition (see components/locale-switcher.test.ts)
// — stubbed here purely to make the module loadable, same as
// components/field-tab-bar.test.ts.
vi.mock('next/link', () => ({ default: (props: Record<string, unknown>) => props }))

import { CompanySwitcher, type OfficeCompanyOption } from './company-switcher'

type El<P> = { type: unknown; props: P }

const ONE_COMPANY: OfficeCompanyOption[] = [{ id: 'co-1', displayName: 'Acme Service Ltd' }]

const TWO_COMPANIES: OfficeCompanyOption[] = [
  { id: 'co-1', displayName: 'Acme Service Ltd' },
  { id: 'co-2', displayName: 'Acme North Ltd' },
]

describe('CompanySwitcher', () => {
  it('doc07: hidden if the tenant has only one company', () => {
    expect(CompanySwitcher({ companies: ONE_COMPANY, activeCompanyId: 'co-1' })).toBeNull()
  })

  it('renders nothing for a tenant with zero companies either', () => {
    expect(CompanySwitcher({ companies: [], activeCompanyId: 'co-1' })).toBeNull()
  })

  it('lists every company for a multi-company tenant, marking the active one', () => {
    const element = CompanySwitcher({ companies: TWO_COMPANIES, activeCompanyId: 'co-2' }) as El<{
      children: El<{ href: string; 'aria-current'?: string; children: string }>[]
    }>

    const links = element.props.children
    expect(links).toHaveLength(2)
    expect(links[0].props.href).toBe('/c/co-1')
    expect(links[0].props.children).toBe('Acme Service Ltd')
    expect(links[0].props['aria-current']).toBeUndefined()

    expect(links[1].props.href).toBe('/c/co-2')
    expect(links[1].props.children).toBe('Acme North Ltd')
    expect(links[1].props['aria-current']).toBe('page')
  })
})

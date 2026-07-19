// app/(field)/layout.test.tsx
//
// FieldLayout is a plain function component with no hooks of its own (see
// its own header comment), so — per this project's established pattern for
// testing React components without jsdom/@testing-library (app/layout.test.tsx) —
// it's tested by calling it directly and asserting on the returned element
// tree. FieldTabBar/SyncStatusChip are referenced here only as element
// *types* (`.type === FieldTabBar`), never invoked, so their own hook usage
// never runs.
//
// Importing FieldLayout transitively imports components/field-tab-bar.tsx
// (next/navigation's barrel) and components/sync-status-chip.tsx
// (lucide-react's icon context, built on React.createContext) — both crash
// under this project's forced 'react-server' resolve condition (see
// components/locale-switcher.test.ts for the full explanation), so both are
// stubbed here purely to make the module graph loadable.
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ usePathname: () => '/today' }))
vi.mock('next/link', () => ({ default: (props: Record<string, unknown>) => props }))
vi.mock('lucide-react', () => ({ CloudOff: 'svg', CloudCheck: 'svg' }))

import FieldLayout from './layout'
import { FieldTabBar } from '@/components/field-tab-bar'
import { SyncStatusChip } from '@/components/sync-status-chip'
import { HerbeServiceLogo } from '@/components/herbe-service-logo'

type El<P = Record<string, unknown>> = { type: unknown; props: P }

describe('FieldLayout', () => {
  it('renders a header, the children in a content area, and the tab bar in that order', () => {
    const element = FieldLayout({ children: 'child-marker' }) as El<{
      children: [El<{ children: unknown[] }>, El<{ children: unknown }>, El]
    }>

    const [header, content, tabBar] = element.props.children

    expect(header.type).toBe('header')
    expect(content.props.children).toBe('child-marker')
    expect(tabBar.type).toBe(FieldTabBar)
  })

  it('renders the logo and sync status chip inside the header', () => {
    const element = FieldLayout({ children: null }) as El<{ children: [El<{ children: [El, El] }>, El, El] }>
    const [header] = element.props.children
    const [logo, chip] = header.props.children

    expect(logo.type).toBe(HerbeServiceLogo)
    expect(chip.type).toBe(SyncStatusChip)
  })
})

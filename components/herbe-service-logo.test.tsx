import { describe, expect, it } from 'vitest'
import { HerbeServiceLogo } from './herbe-service-logo'

// vitest.config.ts forces the 'react-server' resolve condition project-wide
// (next-intl's RSC entrypoint needs it), which makes react-dom/server throw
// ("not supported in Client Components") for any test in this project — so
// no renderToStaticMarkup/@testing-library here. HerbeServiceLogo is a plain
// function component; calling it directly returns the React element tree
// (a plain object graph from the JSX runtime) with no rendering involved,
// which is enough to assert on the SVG's shape.

type El = { type: string; props: Record<string, unknown> }

function child(el: El, index: number): El {
  const children = el.props.children as El[]
  return children[index]
}

describe('HerbeServiceLogo', () => {
  it('renders the correct viewBox', () => {
    const el = HerbeServiceLogo({}) as unknown as El
    expect(el.type).toBe('svg')
    expect(el.props.viewBox).toBe('0 0 268 56')
  })

  it('renders the dot as a square <rect>, not a <circle>', () => {
    const el = HerbeServiceLogo({}) as unknown as El
    const dot = child(el, 1)
    expect(dot.type).toBe('rect')
    expect(dot.props).toMatchObject({ x: 116, y: 37, width: 7, height: 7 })
  })

  it('fills the dot with the --product-service token', () => {
    const el = HerbeServiceLogo({}) as unknown as El
    const dot = child(el, 1)
    expect(dot.props.fill).toBe('var(--product-service)')
  })

  it('renders "herbe" and "service" as separate text runs', () => {
    const el = HerbeServiceLogo({}) as unknown as El
    const herbeText = child(el, 0)
    const serviceText = child(el, 2)
    expect(herbeText.type).toBe('text')
    expect((herbeText.props.children as string)).toBe('herbe')
    expect(serviceText.type).toBe('text')
    expect((serviceText.props.children as string)).toBe('service')
  })

  it('labels the svg for accessibility', () => {
    const el = HerbeServiceLogo({}) as unknown as El
    expect(el.props['aria-label']).toBe('herbe.service')
    expect(el.props.role).toBe('img')
  })

  it('sizes width from height by the fixed aspect ratio', () => {
    const el = HerbeServiceLogo({ height: 56 }) as unknown as El
    expect(el.props.height).toBe(56)
    expect(el.props.width).toBe(268)
  })

  it('defaults to a 28px height', () => {
    const el = HerbeServiceLogo({}) as unknown as El
    expect(el.props.height).toBe(28)
  })

  it('switches text fill colors between dark and light themes, keeping the dot invariant', () => {
    const dark = HerbeServiceLogo({ theme: 'dark' }) as unknown as El
    const light = HerbeServiceLogo({ theme: 'light' }) as unknown as El

    expect(child(dark, 0).props.fill).toBe('#FFFFFF')
    expect(child(light, 0).props.fill).toBe('#231F20')
    expect(child(dark, 1).props.fill).toBe('var(--product-service)')
    expect(child(light, 1).props.fill).toBe('var(--product-service)')
  })

  it('passes through className and style', () => {
    const el = HerbeServiceLogo({ className: 'h-7 w-auto', style: { opacity: 0.9 } }) as unknown as El
    expect(el.props.className).toBe('h-7 w-auto')
    expect(el.props.style).toEqual({ opacity: 0.9 })
  })
})

type Theme = 'dark' | 'light'

// Mirrors herbe-portal's HerbePortalLogo pattern (~/AI/herbe-portal/components/
// herbe-portal-logo.tsx, read-only reference — not this repo's file): inline
// SVG so the page's self-hosted Poppins font actually applies. An <img> of a
// static SVG file is isolated from document CSS and can't load page fonts.

const COLORS: Record<Theme, { herbe: string; service: string }> = {
  dark: { herbe: '#FFFFFF', service: 'rgba(255,255,255,0.6)' },
  light: { herbe: '#231F20', service: '#6B7B78' },
}

// "herbe" (weight 600) is unchanged from herbe-portal-logo.tsx, so the dot
// keeps its x=116 position and "service" keeps the x=129 start (dot.x +
// dot.width + a small gap, same as the portal source). "service" is one
// character longer than "portal", so the viewBox has to widen to avoid
// clipping it — measured with the actual Poppins-Regular.ttf glyph metrics
// (opentype.js, tracked advance width incl. the -0.025em letter-spacing):
// "portal" ≈ 114 SVG units, "service" ≈ 136 SVG units. Portal's viewBox
// (246 wide) leaves ~3 units of right padding after "portal" (129 + 114 =
// 243); matching that same padding for "service" (129 + 136 + 3) gives a
// viewBox width of 268.
const VIEW_BOX = '0 0 268 56'
const ASPECT = 268 / 56
const LABEL = 'herbe.service'

export function HerbeServiceLogo({
  theme = 'dark',
  height = 28,
  className,
  style,
}: {
  theme?: Theme
  height?: number
  className?: string
  style?: React.CSSProperties
}) {
  const c = COLORS[theme]

  return (
    <svg
      viewBox={VIEW_BOX}
      height={height}
      width={Math.round(height * ASPECT)}
      role="img"
      aria-label={LABEL}
      className={className}
      style={style}
    >
      {/* letter-spacing as inline style — SVG presentation attr "-1" (no unit) is invalid CSS and ignored */}
      <text x="0" y="44" fontFamily="Poppins, sans-serif" fontWeight="600" fontSize={40} fill={c.herbe} style={{ letterSpacing: '-0.025em' }}>herbe</text>
      <rect x={116} y={37} width={7} height={7} fill="var(--product-service)" />
      <text x="129" y="44" fontFamily="Poppins, sans-serif" fontWeight="400" fontSize={40} fill={c.service} style={{ letterSpacing: '-0.025em' }}>service</text>
    </svg>
  )
}

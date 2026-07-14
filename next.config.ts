import createNextIntlPlugin from "next-intl/plugin";
import withPWAInit from "@ducanh2912/next-pwa";
import type { NextConfig } from "next";

const withNextIntl = createNextIntlPlugin("./lib/i18n/request.ts");

// Workbox-generated service worker + manifest (Task 16 PWA shell). Disabled
// in dev so the SW never caches stale HMR output.
//
// next-pwa hooks into webpack (workbox-webpack-plugin) and has no Turbopack
// build support yet. Next 16's `next build` defaults to Turbopack, which
// silently no-ops this plugin — the build "succeeds" but public/sw.js is
// never written. package.json's `build` script therefore passes
// `--webpack` to force the webpack builder so the service worker actually
// gets generated. `next dev` is unaffected (PWA is disabled in dev anyway).
const withPWA = withPWAInit({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
});

const nextConfig: NextConfig = {
  /* config options here */
};

// Compose with withNextIntl (Task 3) rather than replacing it — next-intl's
// plugin wraps nextConfig with its own webpack/module resolution, so it must
// run first (innermost) and PWA wraps the result.
export default withPWA(withNextIntl(nextConfig));

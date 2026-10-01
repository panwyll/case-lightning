import type { NextConfig } from 'next';
import { APP_BASE, PROTECTED_SEGMENTS } from './lib/paths';

/**
 * The conveyancer's app moved from the site root to /conveyi — it is CONVEYi, and it now
 * sits with the rest of the product rather than squatting on the root namespace. These
 * redirects keep every bookmark, every emailed decision link and every LEAP task link
 * that was written before the move working, permanently.
 */
const nextConfig: NextConfig = {
  // The smoke test (scripts/smoke.sh) builds into its own folder so it never overwrites a running dev server's.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // mupdf (WebAssembly: locked-PDF detection and unlocking) breaks when bundled ("_ is not a function"): it is loaded from
  // node_modules as it ships, and its .wasm is carried into every server function that can reach it.
  serverExternalPackages: ['pdfjs-dist', 'tesseract.js', '@napi-rs/canvas', 'mupdf', 'heic-decode', 'libheif-js', 'sharp'],
  outputFileTracingIncludes: { '/api/**': ['./node_modules/mupdf/dist/mupdf-wasm.wasm'] },
  // Security headers (docs/security/cyber-essentials-audit.md). The Outlook add-in's pages (/addin) are framed by Outlook, so
  // framing is refused only where nothing legitimate frames the page.
  async headers() {
    const base = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
    ];
    // The client's pages (proof of funds, file links, the portal) carry their secret link in the address: no referrer at all (bank logos are fetched from the provider), and never framed.
    const secret = [{ key: 'Referrer-Policy', value: 'no-referrer' }, { key: 'X-Frame-Options', value: 'DENY' }, { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" }];
    return [
      { source: '/:path*', headers: base },
      { source: '/pof/:path*', headers: secret },
      { source: '/f/:path*', headers: secret },
      { source: '/portal/:path*', headers: secret },
      { source: `${APP_BASE}/:path*`, headers: [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }, { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" }] },
    ];
  },
  async redirects() {
    return PROTECTED_SEGMENTS.flatMap((seg) => [
      { source: `/${seg}`, destination: `${APP_BASE}/${seg}`, permanent: true },
      { source: `/${seg}/:path*`, destination: `${APP_BASE}/${seg}/:path*`, permanent: true },
    ]);
  },
};

export default nextConfig;

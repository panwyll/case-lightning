import type { NextConfig } from 'next';
import { APP_BASE, PROTECTED_SEGMENTS } from './lib/paths';

/**
 * The conveyancer's app moved from the site root to /conveyi — it is CONVEYi, and it now
 * sits with the rest of the product rather than squatting on the root namespace. These
 * redirects keep every bookmark, every emailed decision link and every LEAP task link
 * that was written before the move working, permanently.
 */
const nextConfig: NextConfig = {
  async redirects() {
    return PROTECTED_SEGMENTS.flatMap((seg) => [
      { source: `/${seg}`, destination: `${APP_BASE}/${seg}`, permanent: true },
      { source: `/${seg}/:path*`, destination: `${APP_BASE}/${seg}/:path*`, permanent: true },
    ]);
  },
};

export default nextConfig;

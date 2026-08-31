import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Pin file tracing to this project so a lockfile elsewhere on the machine
  // cannot be mistaken for the workspace root.
  outputFileTracingRoot: process.cwd(),

  // Guest microsites are personal; never let them be indexed or cached by a CDN.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' }],
      },
    ];
  },
};

export default nextConfig;

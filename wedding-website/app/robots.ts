import type { MetadataRoute } from 'next';

/** Private site. Nothing here should ever appear in a search result. */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: '*', disallow: '/' }] };
}

import { redirect } from 'next/navigation';
import { paths } from '@/lib/paths';

/** The case page holds everything now; old links land on its Work tab. */
export default async function EngineMatterRedirect({ params, searchParams }: { params: Promise<{ matterId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { matterId } = await params;
  const sp = await searchParams;
  const tab = typeof sp.tab === 'string' ? sp.tab : 'work';
  redirect(`${paths.matter(matterId)}?tab=${encodeURIComponent(tab)}`);
}

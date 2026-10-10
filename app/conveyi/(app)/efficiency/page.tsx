import { redirect } from 'next/navigation';
import { paths } from '@/lib/paths';

/** Efficiency lives in Analytics, as its first tab. */
export default function EfficiencyPage() {
  redirect(paths.analytics);
}

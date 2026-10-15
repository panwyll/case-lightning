import { redirect } from 'next/navigation';
import { paths } from '@/lib/paths';

/** The baseline page is retired: the measurement (Tools → Measurement) replaces it. */
export default function BaselineRetired() {
  redirect(paths.measure);
}

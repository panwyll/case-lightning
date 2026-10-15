import { redirect } from 'next/navigation';
import { paths } from '@/lib/paths';

/** Measurement lives under Tools, beside the InTouch connector. */
export default function MeasureMoved() {
  redirect(paths.measure);
}

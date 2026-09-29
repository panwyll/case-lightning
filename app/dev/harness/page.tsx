import { notFound } from 'next/navigation';
import { Harness } from './Harness';

/** Local development only: the Tasks list and a case's task panel over an in-memory case (lib/server/dev-harness.ts). */
export default function DevHarnessPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <Harness />;
}

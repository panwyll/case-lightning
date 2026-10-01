import { notFound } from 'next/navigation';
import { DevFirm } from './DevFirm';

/** Local development only: the Firm tab's How CONVEYi Runs and Fees panels over sample settings (no database). */
export default function DevFirmPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <DevFirm />;
}

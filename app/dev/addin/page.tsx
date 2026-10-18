import { notFound } from 'next/navigation';
import { AddinPreview } from './AddinPreview';

/** Local development only: Outlook's pane with a stand-in mailbox (no Office.js), the email chosen by `?msg=` from your filing queue. */
export default function DevAddinPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <AddinPreview />;
}

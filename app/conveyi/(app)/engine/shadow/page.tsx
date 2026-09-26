import { redirect } from 'next/navigation';
import { paths } from '@/lib/paths';

/** Trust levels are the Sign-Offs section of Rules. */
export default function ShadowRedirect() {
  redirect(`${paths.rules}#signoffs`);
}

import { redirect } from 'next/navigation';
import { paths } from '@/lib/paths';

/** The board lives on Case View now. */
export default function CasesRedirect() {
  redirect(paths.matters);
}

import { cookies } from 'next/headers';
import { COOKIE, readToken, type Session } from './auth';

/** Reads whichever of the three sessions the visitor currently holds. */
export async function currentSessions(): Promise<{
  admin: boolean;
  site: boolean;
  guestSlug: string | null;
}> {
  const jar = await cookies();
  const read = async (name: string): Promise<Session | null> => readToken(jar.get(name)?.value);

  const [admin, site, guest] = await Promise.all([
    read(COOKIE.admin),
    read(COOKIE.site),
    read(COOKIE.guest),
  ]);

  return {
    admin: admin?.kind === 'admin',
    site: site?.kind === 'site',
    guestSlug: guest?.kind === 'guest' ? guest.slug : null,
  };
}

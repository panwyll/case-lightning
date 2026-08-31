import { SiteFooter, SiteHeader } from './SiteChrome';
import { VisitBeacon } from './VisitBeacon';

export function PageShell({
  title,
  kicker,
  intro,
  guestName,
  guestSlug,
  path,
  children,
}: {
  title: string;
  kicker?: string;
  intro?: string;
  guestName?: string;
  guestSlug?: string | null;
  path: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <SiteHeader guestName={guestName} />
      <VisitBeacon slug={guestSlug} path={path} />
      <main className="wrap py-14 sm:py-20">
        {kicker ? <p className="text-xs uppercase tracking-[0.2em] text-brass">{kicker}</p> : null}
        <h1 className="mt-3 font-display text-4xl sm:text-5xl">{title}</h1>
        {intro ? <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink-soft">{intro}</p> : null}
        <div className="mt-10">{children}</div>
      </main>
      <SiteFooter />
    </>
  );
}

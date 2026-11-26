import type { Metadata } from 'next';
import { ctaHref, Cta, NavHeader, ROUTES, SiteFooter } from '../../../_components/shared';
import { CASE_STUDY_TITLE, caseStudyVideo } from '@/lib/server/case-study';
import { Vsl } from '../../Vsl';

export const metadata: Metadata = {
  title: 'The Case Study | CONVEYi',
  description: CASE_STUDY_TITLE,
  robots: { index: false },
};
export const dynamic = 'force-dynamic';

const SOURCE = 'case_study';

/** The case study itself (lib/server/case-study.ts), then the one next step: a demo. */
export default function WatchPage() {
  const video = caseStudyVideo();
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader signupHref={ctaHref(ROUTES.demo, SOURCE, 'nav_demo')} signupLabel="Book A Demo" />

      <section className="bg-ink px-6 pb-20 pt-16 text-paper md:pb-28 md:pt-20">
        <div className="mx-auto max-w-5xl">
          <h1 className="mx-auto max-w-4xl text-center font-serif text-4xl font-bold leading-[1.08] tracking-tight [text-wrap:balance] md:text-6xl">{CASE_STUDY_TITLE}</h1>
          <div className="mt-12">
            {video ? (
              <Vsl sources={[{ src: video.src, type: 'video/mp4' }]} poster={video.poster ?? undefined} label={CASE_STUDY_TITLE} duration={video.duration} />
            ) : (
              <div className="flex aspect-video items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-6 text-center">
                <p className="max-w-md text-lg leading-relaxed text-paper/80">The video is nearly ready. We’ll email it to you as soon as it is.</p>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="bg-violet px-6 py-20 text-white md:py-24">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="font-serif text-4xl font-bold leading-[1.1] tracking-tight [text-wrap:balance] md:text-5xl">Want the same for your firm?</h2>
          <p className="mx-auto mt-4 max-w-2xl text-lg leading-relaxed text-white/80 md:text-xl">Find out how much time your team could save, in 15 minutes. It’s free until we’ve doubled your capacity.</p>
          <div className="mt-10"><Cta label="Book A 15 Min Demo" href={ctaHref(ROUTES.demo, SOURCE, 'watch_demo')} dataCta="case_study_demo" variant="onColour" size="xl" /></div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}

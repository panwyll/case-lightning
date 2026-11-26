import type { Metadata } from 'next';
import { ctaHref, NavHeader, ROUTES, SiteFooter } from '../../_components/shared';
import { CASE_STUDY_TITLE } from '@/lib/server/case-study';
import { CaseStudyForm } from './CaseStudyForm';

export const metadata: Metadata = {
  title: 'Free Case Study | CONVEYi',
  description: `${CASE_STUDY_TITLE}. A free video case study.`,
};

/**
 * The free case study: the lead magnet $100M Leads opens with (one firm's result, as a short video, behind a short form).
 * The result is the headline; the form is the only thing to do. The video: watch/page.tsx. The lead: lib/server/case-study.ts.
 */
const SOURCE = 'case_study';

const Stars = () => (
  <div className="flex justify-center gap-1.5 text-[#FFC53D]" role="img" aria-label="5 out of 5 stars">
    {[0, 1, 2, 3, 4].map((i) => (
      <svg key={i} viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" /></svg>
    ))}
  </div>
);

const ERRORS: Record<string, string> = {
  form: 'Check your name, email and phone number, then try again.',
  busy: 'Too many requests from here today. Try again tomorrow.',
};

export default async function CaseStudyPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader signupHref={ctaHref(ROUTES.demo, SOURCE, 'nav_demo')} signupLabel="Book A Demo" />

      <section className="bg-ink px-6 py-20 text-paper md:py-28">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="font-serif text-[2.35rem] font-bold uppercase leading-[1.04] tracking-tight [text-wrap:balance] sm:text-6xl lg:text-[4.25rem]">{CASE_STUDY_TITLE}</h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-paper/75 [text-wrap:balance] md:text-xl">
            A free video case study. What we set up on one call, and where their caseload was by the end of that week.
          </p>
          <div className="mt-12"><CaseStudyForm problem={error ? ERRORS[error] ?? ERRORS.form : null} /></div>
        </div>
      </section>

      <section className="bg-violet px-6 py-20 text-white md:py-24">
        <figure className="mx-auto max-w-4xl text-center">
          <Stars />
          <blockquote className="mt-8 font-serif text-3xl font-bold leading-[1.2] tracking-tight [text-wrap:balance] md:text-5xl">“We got set up on the call and our fee earners were able to handle 150 cases at a time by the end of that week.”</blockquote>
        </figure>
      </section>

      <SiteFooter />
    </main>
  );
}

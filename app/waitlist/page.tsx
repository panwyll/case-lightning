'use client';

import { useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

const WAITLIST_ENDPOINT = process.env.NEXT_PUBLIC_WAITLIST_ENDPOINT ?? '';

// ── Form ──────────────────────────────────────────────────────────────────────
function WaitlistForm() {
  const searchParams = useSearchParams();
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', email: '', firm: '', role: '' });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    // Fire GA4 event
    if (typeof window.gtag === 'function') {
      window.gtag('event', 'waitlist_signup', {
        utm_source: searchParams.get('utm_source') ?? undefined,
        utm_medium: searchParams.get('utm_medium') ?? undefined,
        utm_campaign: searchParams.get('utm_campaign') ?? undefined,
        utm_content: searchParams.get('utm_content') ?? undefined,
        page_location: window.location.href,
        transport_type: 'beacon',
      });
    }

    if (WAITLIST_ENDPOINT) {
      try {
        const resp = await fetch(WAITLIST_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...form,
            utm_source: searchParams.get('utm_source'),
            utm_medium: searchParams.get('utm_medium'),
            utm_campaign: searchParams.get('utm_campaign'),
            utm_content: searchParams.get('utm_content'),
            submitted_at: new Date().toISOString(),
          }),
        });
        if (!resp.ok) throw new Error('Submission failed');
      } catch {
        setError('Something went wrong. Please try again or email us directly.');
        setLoading(false);
        return;
      }
    }

    setSubmitted(true);
    setLoading(false);
  };

  if (submitted) {
    return (
      <div className="text-center">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-brand-500/10 text-3xl text-brand-500">
          ✓
        </div>
        <h2 className="text-2xl font-bold text-white">You&rsquo;re on the list!</h2>
        <p className="mt-3 text-slate-400">
          We&rsquo;ll be in touch as soon as the next intake opens. Keep an eye on your inbox.
        </p>
        <a href="/" className="mt-6 inline-block text-sm text-brand-blue hover:underline">
          ← Back to home
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="name" className="mb-1.5 block text-sm font-medium text-slate-300">
          Full name <span className="text-brand-pink">*</span>
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          value={form.name}
          onChange={handleChange}
          placeholder="Jane Smith"
          className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-white placeholder-slate-500 transition focus:border-brand-blue focus:outline-none focus:ring-1 focus:ring-brand-blue"
        />
      </div>
      <div>
        <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-slate-300">
          Work email <span className="text-brand-pink">*</span>
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          value={form.email}
          onChange={handleChange}
          placeholder="jane@smithsolicitors.co.uk"
          className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-white placeholder-slate-500 transition focus:border-brand-blue focus:outline-none focus:ring-1 focus:ring-brand-blue"
        />
      </div>
      <div>
        <label htmlFor="firm" className="mb-1.5 block text-sm font-medium text-slate-300">
          Firm name <span className="text-brand-pink">*</span>
        </label>
        <input
          id="firm"
          name="firm"
          type="text"
          required
          value={form.firm}
          onChange={handleChange}
          placeholder="Smith Solicitors"
          className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-white placeholder-slate-500 transition focus:border-brand-blue focus:outline-none focus:ring-1 focus:ring-brand-blue"
        />
      </div>
      <div>
        <label htmlFor="role" className="mb-1.5 block text-sm font-medium text-slate-300">
          Your role{' '}
          <span className="font-normal text-slate-500">(optional)</span>
        </label>
        <input
          id="role"
          name="role"
          type="text"
          value={form.role}
          onChange={handleChange}
          placeholder="Solicitor / Practice Manager / Director…"
          className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-white placeholder-slate-500 transition focus:border-brand-blue focus:outline-none focus:ring-1 focus:ring-brand-blue"
        />
      </div>

      {error && (
        <p className="rounded-xl border border-red-700/60 bg-red-900/30 px-4 py-3 text-sm text-red-400">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-xl bg-brand-pink px-6 py-4 text-lg font-semibold text-white shadow-glow-pink transition hover:bg-brand-pink-dim active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? 'Joining…' : 'Join the Waitlist'}
      </button>
    </form>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function WaitlistPage() {
  return (
    <main className="min-h-screen bg-slate-950 text-white antialiased">
      {/* Nav */}
      <header className="border-b border-slate-800/80 bg-slate-950/95 shadow-[0_1px_20px_rgba(0,0,0,0.5)]">
        <div className="mx-auto flex max-w-6xl items-center px-6 py-4">
          <a href="/" className="text-xl font-bold tracking-tight transition hover:opacity-80">
            Case<span className="text-brand-500">Lightning</span>
          </a>
        </div>
      </header>

      {/* Body */}
      <div className="relative overflow-hidden px-6 py-16 md:py-24">
        {/* Glow */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div
            aria-hidden="true"
            className="h-[400px] w-[700px] rounded-full bg-brand-pink opacity-[0.06] blur-3xl"
          />
        </div>

        {/* Headline */}
        <div className="relative mx-auto max-w-lg text-center">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-pink/10 text-3xl shadow-glow-pink">
            ⚡
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight md:text-4xl">
            We&rsquo;re currently oversubscribed
          </h1>
          <p className="mt-4 text-lg text-slate-400">
            CaseLightning is not taking on new clients until the next intake. Join the waitlist and
            we&rsquo;ll reach out as soon as a spot opens up.
          </p>
        </div>

        {/* Card */}
        <div className="relative mx-auto mt-12 max-w-md rounded-3xl border border-slate-700/60 bg-slate-900 p-8 shadow-[0_8px_40px_rgba(0,0,0,0.55)]">
          <Suspense fallback={null}>
            <WaitlistForm />
          </Suspense>
        </div>

        <p className="mt-8 text-center text-sm text-slate-600">
          <a href="/" className="transition-colors hover:text-slate-400">
            ← Back to CaseLightning
          </a>
        </p>
      </div>
    </main>
  );
}

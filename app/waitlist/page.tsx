'use client';

import { useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

const inputClass =
  'w-full rounded-xl border border-line bg-paper-soft px-4 py-3 text-ink placeholder-ink-soft/50 transition focus:border-violet focus:outline-none focus:ring-1 focus:ring-violet';

function WaitlistForm() {
  const searchParams = useSearchParams();
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [error, setError] = useState('');
  const [errorDetails, setErrorDetails] = useState('');
  const [diagnostics, setDiagnostics] = useState('');
  const [controller, setController] = useState<AbortController | null>(null);
  const [form, setForm] = useState({ first_name: '', surname: '', email: '' });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setTimedOut(false);
    setError('');
    setErrorDetails('');
    setDiagnostics('');

    const abortController = new AbortController();
    setController(abortController);
    const timeoutId = window.setTimeout(() => setTimedOut(true), 15000);

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

    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
        signal: abortController.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = typeof data.error === 'string' ? data.error : 'We could not complete your signup right now. Please try again.';
        const action = typeof data.action === 'string' ? ` ${data.action}` : '';
        const details = typeof data.details === 'string' ? data.details : '';
        const requestId = typeof data.request_id === 'string' ? data.request_id : 'unknown';
        const stage = typeof data.stage === 'string' ? data.stage : 'unknown';
        setError(`${message}${action}`);
        setErrorDetails(details);
        setDiagnostics(`request_id=${requestId}; stage=${stage}; status=${res.status}`);
        setLoading(false);
        setController(null);
        window.clearTimeout(timeoutId);
        return;
      }
    } catch {
      setError(abortController.signal.aborted ? 'Cancelled. You can retry when ready.' : 'Something went wrong. Please try again, or email us directly.');
      setLoading(false);
      setController(null);
      window.clearTimeout(timeoutId);
      return;
    }

    setSubmitted(true);
    setLoading(false);
    setController(null);
    window.clearTimeout(timeoutId);
  };

  const handleCancel = () => {
    controller?.abort();
    setLoading(false);
    setTimedOut(false);
    setController(null);
  };

  const copyDiagnostics = async () => {
    if (diagnostics) await navigator.clipboard.writeText(diagnostics).catch(() => {});
  };

  if (submitted) {
    return (
      <div className="text-center">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-violet-soft text-3xl text-violet">✓</div>
        <h2 className="font-serif text-3xl font-semibold tracking-tight text-ink">You’re on the list.</h2>
        <p className="mt-3 text-ink-soft">We’ll be in touch the moment the next intake opens. Keep an eye on your inbox.</p>
        <a href="/conveyi" className="mt-6 inline-block text-sm font-semibold text-violet hover:underline">← Back to CONVEYi</a>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 text-left">
      <div>
        <label htmlFor="first_name" className="mb-1.5 block text-sm font-medium text-ink">First name <span className="text-violet">*</span></label>
        <input id="first_name" name="first_name" type="text" required value={form.first_name} onChange={handleChange} placeholder="Jane" className={inputClass} />
      </div>
      <div>
        <label htmlFor="surname" className="mb-1.5 block text-sm font-medium text-ink">Surname <span className="text-violet">*</span></label>
        <input id="surname" name="surname" type="text" required value={form.surname} onChange={handleChange} placeholder="Smith" className={inputClass} />
      </div>
      <div>
        <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-ink">Work email <span className="text-violet">*</span></label>
        <input id="email" name="email" type="email" required value={form.email} onChange={handleChange} placeholder="jane@smithsolicitors.co.uk" className={inputClass} />
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <p>{error}</p>
          {errorDetails && <p className="mt-1 text-red-600/80">{errorDetails}</p>}
          {diagnostics && (
            <button type="button" onClick={copyDiagnostics} className="mt-2 text-xs font-medium text-red-700 underline underline-offset-2">
              Copy diagnostics
            </button>
          )}
        </div>
      )}

      {timedOut && loading && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          This is taking longer than usual.{' '}
          <button type="button" onClick={handleCancel} className="font-semibold underline underline-offset-2">Cancel</button> and try again?
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-full bg-violet px-6 py-3.5 text-base font-semibold text-white shadow-violet transition hover:bg-violet-dark active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? 'Joining…' : 'Join the waitlist'}
      </button>
    </form>
  );
}

export default function WaitlistPage() {
  return (
    <main className="min-h-screen bg-paper text-ink antialiased">
      <header className="border-b border-line/80 bg-paper">
        <div className="mx-auto flex max-w-6xl items-center px-6 py-4">
          <a href="/conveyi" className="flex items-baseline gap-2 transition hover:opacity-80">
            <span className="text-xl font-extrabold tracking-tight text-ink">
              CONVE<span className="text-violet">Yi</span>
            </span>
            <span className="hidden text-xs font-medium text-ink-soft sm:inline">by Case Lightning</span>
          </a>
        </div>
      </header>

      <div className="px-6 py-16 md:py-24">
        <div className="mx-auto max-w-lg text-center">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet">Join the waitlist</p>
          <h1 className="mt-4 font-serif text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
            We’re onboarding firms in small batches.
          </h1>
          <p className="mt-4 text-lg text-ink-soft">
            CONVEYi is taking on new firms a few at a time so every team gets a proper start. Join the
            waitlist and we’ll reach out the moment a place opens.
          </p>

          <div className="mt-10 rounded-3xl border border-line bg-paper-soft p-8 text-left shadow-card">
            <Suspense fallback={null}>
              <WaitlistForm />
            </Suspense>
          </div>

          <p className="mt-6 text-sm text-ink-soft">
            From £200/month · 30-day money-back guarantee · nothing to install
          </p>
        </div>
      </div>
    </main>
  );
}

'use client';

/**
 * Account & billing area for a signed-in firm.
 *
 * A full-page route (not the taskpane) because billing redirects need width and
 * users can reach it from a normal browser. It reads the same `cl_token` session
 * the taskpane uses; the taskpane deep-links here with the token in the URL
 * fragment (#token=…) so desktop Outlook — whose webview has its own cookie/storage
 * jar — can still authenticate. On Outlook on the web the session cookie alone works.
 *
 * Subscription management itself is delegated to the Stripe Billing Portal: the
 * "Manage subscription" button mints a portal session server-side and redirects.
 */
import { useCallback, useEffect, useState } from 'react';

const TOKEN_KEY = 'cl_token';

interface Seat {
  email: string;
  displayName: string | null;
  role: string;
}
interface Summary {
  plan: string | null;
  status: string;
  trialing: boolean;
  hasSubscription: boolean;
  seats: Seat[];
  seatCount: number;
  pricePerCasePennies: number;
  cases: { thisMonth: number; billedThisMonth: number; billedPenniesThisMonth: number; allTime: number };
  referralCode: string;
  referralLink: string;
  creditBalancePennies: number;
  currency: string;
  commissionPennies: number;
  referrals: { total: number; active: number };
  commissions: { accruedPennies: number; appliedPennies: number; clawedBackPennies: number };
}

function token(): string | null {
  return typeof window !== 'undefined' ? window.localStorage.getItem(TOKEN_KEY) : null;
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const t = token();
  const res = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { status: res.status, body: json });
  return json as T;
}

function money(pennies: number, currency: string): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency.toUpperCase() }).format(pennies / 100);
}

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  active: { label: 'Active', cls: 'bg-green-100 text-green-800' },
  trialing: { label: 'Trial', cls: 'bg-violet-soft text-violet-dark' },
  past_due: { label: 'Past due', cls: 'bg-amber-100 text-amber-800' },
  canceled: { label: 'Canceled', cls: 'bg-red-100 text-red-700' },
  none: { label: 'No subscription', cls: 'bg-slate-100 text-slate-600' },
};


export default function AccountPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Capture a token handed over in the URL fragment (desktop deep-link), persist
  // it like the taskpane does, then strip it from the URL so it isn't bookmarked.
  useEffect(() => {
    const hash = window.location.hash;
    const m = hash.match(/token=([^&]+)/);
    if (m) {
      window.localStorage.setItem(TOKEN_KEY, decodeURIComponent(m[1]));
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      setSummary(await api<Summary>('/billing/account'));
    } catch (e: any) {
      if (e.status === 401) setError('unauth');
      else setError(e.message || 'Something went wrong.');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function manageSubscription() {
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>('/billing/portal', { method: 'POST' });
      window.location.href = url;
    } catch (e: any) {
      if (e.status === 409) {
        // No subscription yet → send them to checkout instead.
        window.location.href = '/start-trial';
        return;
      }
      setError(e.message || 'Could not open the billing portal.');
      setBusy(false);
    }
  }

  async function subscribe() {
    setBusy(true);
    try {
      const res = await api<{ url?: string; updated?: boolean }>('/billing/checkout', { method: 'POST' });
      if (res.url) {
        window.location.href = res.url; // new subscriber → Stripe Checkout
        return;
      }
      await load(); // already subscribed → nothing to change; refresh
    } catch (e: any) {
      setError(e.message || 'Could not start your subscription.');
    } finally {
      setBusy(false);
    }
  }

  function copyReferral() {
    if (!summary) return;
    navigator.clipboard?.writeText(summary.referralLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  if (error === 'unauth') {
    return (
      <Shell>
        <Card>
          <h2 className="font-serif text-xl text-ink">Please sign in</h2>
          <p className="mt-2 text-ink-soft">
            Open the CONVEYi add-in in Outlook and connect your Microsoft 365 account, then return here.
          </p>
          <a href="/api/v1/auth/login" className="mt-4 inline-block rounded-lg bg-violet px-4 py-2 font-semibold text-white shadow-violet">
            Sign in
          </a>
        </Card>
      </Shell>
    );
  }

  if (!summary) {
    return (
      <Shell>
        <p className="text-ink-soft">{error || 'Loading your account…'}</p>
      </Shell>
    );
  }

  const status = STATUS_LABEL[summary.status] ?? { label: summary.status, cls: 'bg-line text-ink-soft' };
  const perCase = money(summary.pricePerCasePennies, summary.currency);

  return (
    <Shell>
      {/* Plan & subscription */}
      <Card>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Your plan</p>
            <h2 className="mt-1 font-serif text-2xl text-ink">{perCase} per case</h2>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${status.cls}`}>{status.label}</span>
        </div>

        {summary.status === 'past_due' && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Your last payment failed. Update your card to keep your team running.
          </p>
        )}

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg bg-paper-soft px-3 py-2">
            <p className="text-xs text-ink-soft">Cases this month</p>
            <p className="font-serif text-2xl text-ink">{summary.cases.thisMonth}</p>
          </div>
          <div className="rounded-lg bg-paper-soft px-3 py-2">
            <p className="text-xs text-ink-soft">Billed this month</p>
            <p className="font-serif text-2xl text-ink">{money(summary.cases.billedPenniesThisMonth, summary.currency)}</p>
          </div>
          <div className="rounded-lg bg-paper-soft px-3 py-2">
            <p className="text-xs text-ink-soft">Free on trial</p>
            <p className="font-serif text-2xl text-ink">{summary.cases.thisMonth - summary.cases.billedThisMonth}</p>
          </div>
          <div className="rounded-lg bg-paper-soft px-3 py-2">
            <p className="text-xs text-ink-soft">Cases all time</p>
            <p className="font-serif text-2xl text-ink">{summary.cases.allTime}</p>
          </div>
        </div>
        <p className="mt-3 text-sm text-ink-soft">
          A case is charged once, the first time CONVEYi drafts, reviews, generates or reconciles something on it.
          Triage, matching and summaries are free. Cases opened on your trial are never charged.
        </p>

        <div className="mt-4 flex flex-wrap gap-3">
          {!summary.hasSubscription && (
            <button
              onClick={subscribe}
              disabled={busy}
              className="rounded-lg bg-violet px-4 py-2 font-semibold text-white shadow-violet disabled:opacity-60"
            >
              {busy ? 'Working…' : 'Add payment details'}
            </button>
          )}
          {summary.hasSubscription && (
            <button
              onClick={manageSubscription}
              disabled={busy}
              className="rounded-lg border border-line bg-paper-soft px-4 py-2 font-semibold text-ink disabled:opacity-60"
            >
              Manage subscription
            </button>
          )}
        </div>
        {summary.hasSubscription && (
          <p className="mt-2 text-sm text-ink-soft">
            “Manage subscription” opens Stripe for your card, invoices &amp; cancellation.
          </p>
        )}
      </Card>

      {/* Team seats */}
      <Card>
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
            Team &middot; {summary.seatCount} {summary.seatCount === 1 ? 'seat' : 'seats'}
          </p>
        </div>
        <ul className="mt-3 divide-y divide-line">
          {summary.seats.map((s) => (
            <li key={s.email} className="flex items-center justify-between py-2">
              <div>
                <p className="text-ink">{s.displayName || s.email}</p>
                {s.displayName && <p className="text-xs text-ink-soft">{s.email}</p>}
              </div>
              <span className="rounded-full bg-line px-2.5 py-0.5 text-xs text-ink-soft">{s.role.toLowerCase()}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-ink-soft">
          Colleagues join by signing in with their Microsoft 365 account — in the CONVEYi add-in or on the web — and
          they’re added to your firm automatically. Seats are free: you pay per case, not per person.
        </p>
      </Card>

      {/* Referrals & credit */}
      <Card>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Refer a firm, earn credit</p>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-2">
          <span className="font-serif text-2xl text-ink">{money(summary.creditBalancePennies, summary.currency)}</span>
          <span className="text-sm text-ink-soft">credit balance</span>
        </div>
        <p className="mt-1 text-sm text-ink-soft">
          Earn up to {money(summary.commissionPennies, summary.currency)}/month for every firm you refer (a quarter of
          what they pay), for as long as they stay. {summary.referrals.active} active of {summary.referrals.total} referred.
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          <input
            readOnly
            value={summary.referralLink}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 rounded-lg border border-line bg-paper-soft px-3 py-2 text-sm text-ink"
          />
          <button onClick={copyReferral} className="rounded-lg border border-line bg-paper-soft px-4 py-2 font-semibold text-ink">
            {copied ? 'Copied!' : 'Copy link'}
          </button>
        </div>

        {summary.commissions.appliedPennies > 0 && (
          <p className="mt-2 text-xs text-ink-soft">
            {money(summary.commissions.appliedPennies, summary.currency)} earned to date.
          </p>
        )}
      </Card>

      {error && error !== 'unauth' && <p className="text-sm text-red-600">{error}</p>}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-paper px-4 py-10 text-ink">
      <div className="mx-auto max-w-2xl">
        <header className="mb-6 flex items-center gap-2">
          <svg viewBox="0 0 32 32" width="24" height="24" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="#5A27E0" />
            <path d="M5 16 C9 10 13 10 16 16 C19 22 23 22 27 16" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" />
          </svg>
          <strong className="text-lg">
            CONVE<span className="text-violet">Yi</span>
          </strong>
          <span className="ml-auto text-sm text-ink-soft">Account</span>
        </header>
        <div className="space-y-4">{children}</div>
      </div>
    </main>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <section className="rounded-2xl border border-line bg-paper-soft p-5 shadow-card">{children}</section>;
}

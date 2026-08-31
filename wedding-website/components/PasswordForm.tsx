'use client';

import { useState } from 'react';

export function PasswordForm({
  endpoint,
  next,
  label,
  cta,
}: {
  endpoint: string;
  next: string;
  label: string;
  cta: string;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password, next }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? 'That did not work.');
        setBusy(false);
        return;
      }
      const data = (await res.json()) as { redirect: string };
      // A hard navigation, so the new cookie is present for the middleware.
      window.location.href = data.redirect;
    } catch {
      setError('Could not reach the server. Try again.');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <label className="label" htmlFor="password">
          {label}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          className="field"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-brass-dark">
          {error}
        </p>
      ) : null}
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'One moment…' : cta}
      </button>
    </form>
  );
}

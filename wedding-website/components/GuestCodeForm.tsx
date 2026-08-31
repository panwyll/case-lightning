'use client';

import { useState } from 'react';

/** Fallback for a guest whose link has lost its ?k= — they can type the code. */
export function GuestCodeForm({ slug }: { slug: string }) {
  const [code, setCode] = useState('');

  return (
    <form action={`/g/${slug}/enter`} method="get" className="mt-6 flex flex-wrap gap-3">
      <label className="sr-only" htmlFor="k">
        Your access code
      </label>
      <input
        id="k"
        name="k"
        className="field max-w-56 font-mono uppercase tracking-widest"
        placeholder="ABCD1234"
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        required
      />
      <button type="submit" className="btn-primary">
        Open my page
      </button>
    </form>
  );
}

'use client';

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-16 text-center">
      <div className="max-w-md">
        <h1 className="font-display text-4xl">That did not work</h1>
        <p className="mt-4 leading-relaxed text-ink-soft">
          Something broke on our side. Nothing you did caused it, and nothing you
          typed has been lost from the RSVP unless you reload.
        </p>
        <button type="button" onClick={reset} className="btn-primary mt-8">
          Try again
        </button>
      </div>
    </main>
  );
}

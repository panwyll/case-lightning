import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-16 text-center">
      <div className="max-w-md">
        <h1 className="font-display text-4xl">Nothing here</h1>
        <p className="mt-4 leading-relaxed text-ink-soft">
          This page does not exist, or it is not ready yet. Both are equally likely.
        </p>
        <Link href="/" className="btn-primary mt-8">
          Back to the beginning
        </Link>
      </div>
    </main>
  );
}

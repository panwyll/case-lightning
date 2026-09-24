'use client';
import { use } from 'react';
import { DecisionPanel } from '@/app/shared/engine/DecisionPanel';

/** Addendum 3 §3 — one decision, full screen: summary / source / actions. Deep-linkable from the timeline and the queue. */
export default function DecisionPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = use(params);
  return <DecisionPanel eventId={eventId} />;
}

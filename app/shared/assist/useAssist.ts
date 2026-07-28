'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The assist brain, shared by the Outlook taskpane and the web inbox: call /assist for
 * the open message, show the fast half immediately, then poll quietly until the slow
 * half (thread summary + prepared reply) lands.
 *
 * Extracted so the two surfaces can't drift — the polling/cancellation/quota rules are
 * subtle and must behave identically wherever an email is opened.
 */

export interface AssistData {
  triageId: string;
  classification: { intent: string; needsAttention: boolean; urgency: string; reason: string };
  matchBand: string;
  matter: { id: string; matterRef: string; propertyAddress: string | null } | null;
  candidates: Array<{ matterId: string; matterRef: string; propertyAddress: string; score: number; band: string }>;
  ask: string;
  /** Short assistant-voice heads-up (from the slow phase); falls back to `ask` until ready. */
  brief: string;
  whatWeKnow: string[];
  outstanding: string[];
  draft: { subject: string; bodyHtml: string; why: string[] } | null;
  /** Per-attachment summaries for the email tab (empty until the slow half lands). */
  documents?: Array<{ name: string; docType: string; summary: string }>;
  highlighted: string[];
  /** False while the slow half (thread summary + draft) is still being prepared. */
  ready: boolean;
}

export interface QuotaHit { used: number; cap: number; hoursSaved: number }

type Api = <T = any>(path: string, options?: RequestInit) => Promise<T>;

/** How long a single /assist call may hang before we give up (Office webviews can stall). */
const CALL_TIMEOUT_MS = 30_000;
const POLL_EVERY_MS = 1_500;
const POLL_MAX_TRIES = 40;

export function useAssist(opts: {
  messageId: string;
  conversationId: string;
  api: Api;
  /** Wraps a call with the surface's own busy/status toast; returns nullish on failure. */
  run: <T>(label: string, fn: () => Promise<T>) => Promise<T | null | undefined>;
  /** Over the monthly email cap — the surface shows its upgrade nudge. */
  onQuota?: (q: QuotaHit) => void;
  /** The assist resolved a matter we weren't already on. */
  onMatterFound?: (matterId: string) => void;
}) {
  const { messageId, conversationId, api, run, onQuota, onMatterFound } = opts;
  const [assist, setAssist] = useState<AssistData | null>(null);
  const [assistError, setAssistError] = useState(false);
  // Identifies the email a poll loop belongs to; changing it cancels the old loop.
  const pollRef = useRef<string>('');

  // Cancel any in-flight poll when the component goes away (or the message changes),
  // so a discarded pane can't keep polling for up to a minute in the background.
  useEffect(() => () => { pollRef.current = ''; }, []);
  useEffect(() => { pollRef.current = ''; }, [messageId]);

  const runAssist = useCallback(
    async (matterId?: string) => {
      const pollKey = messageId;
      pollRef.current = pollKey; // cancels any in-flight poll for a prior email
      setAssistError(false);

      const call = async (): Promise<AssistData> => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
        try {
          return await api<AssistData>('/assist', {
            method: 'POST',
            signal: ctrl.signal,
            // Omit tone so the response matches the precomputed cache; tone-specific
            // redrafts go through the dedicated draft-reply path.
            body: JSON.stringify({ messageId, conversationId, matterId: matterId || undefined }),
          });
        } finally {
          clearTimeout(t);
        }
      };

      // The first call returns fast — either the cached full result or just the fast
      // half — so the spinner clears quickly and the situation shows at once.
      const first = await run('Reading the email', async () => {
        if (!conversationId) throw new Error('Open an email first.');
        if (!messageId) throw new Error('Open an email first.');
        return call();
      });
      if (!first) {
        // Only surface the error when the email is still the one we tried to read —
        // a fast switch to another message shouldn't flash a stale failure.
        if (pollRef.current === pollKey) setAssistError(true);
        return;
      }
      // Hit the monthly email cap → show the time-saving + upgrade nudge, don't analyse.
      if ((first as any).overQuota) {
        if (pollRef.current === pollKey) {
          onQuota?.({
            used: (first as any).emailsUsed ?? 0,
            cap: (first as any).emailsCap ?? 0,
            hoursSaved: (first as any).hoursSavedThisMonth ?? 0,
          });
          setAssistError(true);
        }
        return;
      }
      setAssist(first);
      if (first.matter && !matterId) onMatterFound?.(first.matter.id);

      // Slow half not ready yet → poll quietly until it lands, updating in place.
      let current = first;
      let tries = 0;
      while (!current.ready && pollRef.current === pollKey && tries < POLL_MAX_TRIES) {
        await new Promise((res) => setTimeout(res, POLL_EVERY_MS));
        if (pollRef.current !== pollKey) return; // a newer email took over
        tries++;
        try {
          const next = await call();
          if (pollRef.current !== pollKey) return;
          setAssist(next);
          current = next;
        } catch {
          /* transient — keep polling */
        }
      }
    },
    [messageId, conversationId, api, run, onQuota, onMatterFound]
  );

  return { assist, setAssist, assistError, setAssistError, runAssist, pollRef };
}

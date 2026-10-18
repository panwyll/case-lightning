'use client';
import { useState } from 'react';
import Taskpane from '@/app/addin/taskpane/page';

/** A stand-in for Outlook's mailbox, set before the pane mounts: the email is `?msg=` (a queued message id), its conversation `?conv=`. */
export function AddinPreview() {
  useState(() => {
    if (typeof window === 'undefined') return null;
    const q = new URLSearchParams(window.location.search);
    (window as unknown as { Office: unknown }).Office = {
      onReady: (cb: (i: { host: string }) => void) => cb({ host: 'Outlook' }),
      MailboxEnums: {},
      EventType: {},
      context: { mailbox: { addHandlerAsync: () => {}, item: q.get('msg') ? { itemId: q.get('msg'), conversationId: q.get('conv') ?? '', subject: q.get('subject') ?? 'An email', from: { emailAddress: q.get('from') ?? 'someone@example.test', displayName: q.get('from') ?? 'Someone' } } : undefined } },
    };
    return null;
  });
  return <div style={{ width: 360, border: '1px solid #e6e8ee', margin: 16 }}><Taskpane /></div>;
}

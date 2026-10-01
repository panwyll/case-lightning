'use client';
import { useState } from 'react';
import { FeesEditor, FirmSetup } from '@/app/conveyi/(app)/admin/FirmDetails';
import { COMMON_EXTRAS, FEE_CONDITIONS } from '@/lib/server/analytics/fees';

let settings = {
  mode: 'standalone', modes: [{ value: 'standalone', label: 'The Whole Case System' }, { value: 'alongside', label: 'Alongside LEAP Or InTouch' }],
  features: [{ key: 'clientPortal', label: 'Client Portal', on: true, byDefault: true, overridden: false }, { key: 'orderSearches', label: 'Order Searches From CONVEYi', on: true, byDefault: true, overridden: false }, { key: 'orderIdChecks', label: 'Order ID Checks From CONVEYi', on: false, byDefault: true, overridden: true }, { key: 'satisfactionSurveys', label: 'Ask Clients How We Did', on: true, byDefault: true, overridden: false }],
  targets: { monthlyCompletions: 24, perPerson: {} },
  fees: { purchase: [{ upTo: 250000, fee: 950 }, { upTo: 500000, fee: 1150 }, { upTo: null, fee: 1450 }], sale: [{ upTo: null, fee: 995 }], remortgage: [], transfer: [], extras: [{ id: 'a', label: 'ID Check', fee: 15, when: 'each_id_check', sides: [] }, { id: 'b', label: 'Leasehold Supplement', fee: 350, when: 'leasehold', sides: [] }] },
  feeConditions: Object.entries(FEE_CONDITIONS).map(([value, c]) => ({ value, label: c.label })),
  commonExtras: COMMON_EXTRAS, reviewUrl: null, canEdit: true,
};

/** Answers the panels' calls from memory, so they can be seen without signing in. */
function useFakeApi() {
  const [ready] = useState(() => {
    if (typeof window === "undefined") return false;
    const real = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/admin/features')) {
        if (init?.method === 'PATCH') settings = { ...settings, ...JSON.parse(String(init.body)) };
        return new Response(JSON.stringify(settings), { headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/admin/users')) return new Response(JSON.stringify({ users: [{ id: 'u1', email: 'asha@firm.test', display_name: 'Asha Patel' }, { id: 'u2', email: 'ben@firm.test', display_name: 'Ben Carter' }] }), { headers: { 'content-type': 'application/json' } });
      return real(input, init);
    };
    return true;
  });
  return ready;
}

export function DevFirm() {
  useFakeApi();
  return <div style={{ background: '#f6f7fb', minHeight: '100vh', padding: 22, maxWidth: 1000, fontFamily: '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif' }}><FirmSetup /><FeesEditor /></div>;
}

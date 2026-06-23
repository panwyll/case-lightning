import type { Metadata } from 'next';
import { NavHeader, SiteFooter, ctaHref, ROUTES } from '../../_components/shared';

export const metadata: Metadata = {
  title: 'Document templates — CONVEYi',
  description:
    'How to set up and use document templates in CONVEYi: upload your firm’s Word documents, drop in {{placeholders}}, and generate ready-to-send client documents from any matter — with optional AI-written sections on the Team plan.',
};

const PAGE_SOURCE = 'doc_packs_guide';

const VARS: Array<[string, string]> = [
  ['{{matter_ref}}', 'Matter reference, e.g. CL-0042'],
  ['{{property_address}}', 'Full property address'],
  ['{{buyer_names}}', 'Buyer name(s), comma-separated'],
  ['{{seller_names}}', 'Seller name(s), comma-separated'],
  ['{{exchange_date}}', 'Target exchange date (e.g. 14 July 2026)'],
  ['{{completion_date}}', 'Target completion date'],
  ['{{counterparty_solicitor}}', 'The other side’s solicitor'],
  ['{{counterparty_agent}}', 'Estate agent'],
  ['{{lender}}', 'Lender name'],
  ['{{track}}', 'Purchase, Sale or Remortgage'],
  ['{{stage}}', 'Current stage of the matter'],
  ['{{today}}', 'Today’s date'],
  ['{{firm_name}}', 'Your firm’s name'],
  ['{{assigned_to}}', 'The conveyancer handling the matter'],
];

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-ink/[0.06] px-1.5 py-0.5 font-mono text-[0.9em] text-ink">
      {children}
    </code>
  );
}

export default function DocPacksGuidePage() {
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader signupHref={ctaHref(ROUTES.signup, PAGE_SOURCE, 'nav_signup')} />

      <section className="mx-auto max-w-3xl px-6 pt-16 pb-12 md:pt-24">
        <p className="text-sm font-semibold uppercase tracking-wide text-ink/50">Guide</p>
        <h1 className="mt-2 text-3xl font-bold md:text-4xl">Document templates</h1>
        <p className="mt-4 text-lg text-ink/70">
          Upload your firm’s standard documents once. From then on, anyone can generate a
          filled-in copy for any matter in a single click — the client care letter, completion
          statement, report on title and anything else you send regularly.
        </p>

        {/* How it works */}
        <h2 className="mt-12 text-2xl font-semibold">How it works</h2>
        <ol className="mt-4 space-y-4 text-ink/80">
          <li>
            <span className="font-semibold">1. Upload your templates.</span> In{' '}
            <Mono>Admin → Doc packs</Mono>, upload your existing Word (<Mono>.docx</Mono>) documents.
            Anywhere a matter detail should appear, write a placeholder like{' '}
            <Mono>{'{{property_address}}'}</Mono>.
          </li>
          <li>
            <span className="font-semibold">2. Open a matter in Outlook.</span> In the CONVEYi
            sidebar, go to the <span className="font-semibold">Files</span> tab. Your templates are
            listed under <span className="font-semibold">Templates</span>.
          </li>
          <li>
            <span className="font-semibold">3. Click Generate.</span> CONVEYi fills the template with
            that matter’s data and saves the finished document into the case’s OneDrive folder, where
            it appears under <span className="font-semibold">Case files</span> — ready to review and send.
          </li>
        </ol>

        {/* Placeholders */}
        <h2 className="mt-12 text-2xl font-semibold">Placeholders</h2>
        <p className="mt-3 text-ink/70">
          Type these anywhere in your document — in a sentence, a heading, a table cell. They’re
          replaced with the matter’s details instantly, with no AI involved.
        </p>
        <div className="mt-4 overflow-hidden rounded-xl border border-ink/10">
          <table className="w-full text-sm">
            <tbody>
              {VARS.map(([code, desc], i) => (
                <tr key={code} className={i % 2 ? 'bg-ink/[0.02]' : ''}>
                  <td className="whitespace-nowrap px-4 py-2 align-top">
                    <Mono>{code}</Mono>
                  </td>
                  <td className="px-4 py-2 text-ink/70">{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-sm text-ink/50">
          If a detail isn’t recorded on the matter yet, its placeholder is simply left blank — the
          document still generates.
        </p>

        {/* AI sections */}
        <h2 className="mt-12 text-2xl font-semibold">
          AI-written sections <span className="align-middle text-sm font-medium text-violet">Team plan</span>
        </h2>
        <p className="mt-3 text-ink/70">
          For the parts of a document that change with each matter — a tailored summary, a paragraph
          explaining the next steps — you can ask Claude to write them. Use double square brackets and
          write the instruction in plain English:
        </p>
        <pre className="mt-4 overflow-x-auto rounded-xl border border-ink/10 bg-ink/[0.03] p-4 text-sm">
{`[[Write a short, friendly paragraph welcoming {{buyer_names}}
to their purchase of {{property_address}} and explaining that we
will be in touch with next steps shortly.]]`}
        </pre>
        <p className="mt-3 text-ink/70">
          When the template is generated, each <Mono>[[ … ]]</Mono> block is replaced with text Claude
          writes from that matter’s details. You can mix <Mono>{'{{placeholders}}'}</Mono> inside an AI
          instruction, as above.
        </p>
        <ul className="mt-4 space-y-2 text-sm text-ink/70">
          <li>• Keep instructions specific — say what to write and roughly how long.</li>
          <li>• Always read AI-written sections before sending. They’re a first draft, not advice.</li>
          <li>
            • On plans without AI sections, <Mono>[[ … ]]</Mono> blocks are left blank, so the rest of
            the document still fills in correctly.
          </li>
        </ul>

        {/* Tips */}
        <h2 className="mt-12 text-2xl font-semibold">Tips</h2>
        <ul className="mt-4 space-y-2 text-ink/70">
          <li>• Start from a document you already use — just swap the variable bits for placeholders.</li>
          <li>• The generated file is named after the template, so re-generating updates the same document (we’ll ask before overwriting).</li>
          <li>• Not sure where to begin? In <Mono>Admin → Doc packs</Mono>, click <span className="font-semibold">Load example templates</span> for a client care letter, completion statement and an AI-powered report on title to copy from.</li>
        </ul>

        <div className="mt-12 rounded-xl border border-ink/10 bg-ink/[0.02] p-5 text-sm text-ink/70">
          <span className="font-semibold text-ink">Admins:</span> manage your template library in{' '}
          <Mono>Admin → Doc packs</Mono> — upload, download, reorder or remove templates there.
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}

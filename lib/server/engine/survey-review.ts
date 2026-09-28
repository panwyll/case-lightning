/**
 * What a conveyancer does with the buyer's survey.
 *
 * The survey is the buyer's own report. A conveyancer is not a surveyor and does not advise
 * on condition, but two things in it are theirs:
 *
 *   1. The surveyor's "Issues for your legal advisers" (RICS Home Survey section H:
 *      regulation, guarantees, other matters). The Protocol lets the buyer's solicitor raise
 *      enquiries arising from the surveyor's report: each point becomes an enquiry to the
 *      seller's solicitor for the documents or confirmation it needs.
 *   2. Making sure the client has decided about the condition before exchange commits them:
 *      what the surveyor rates urgent (condition rating 3, where RICS says to get written
 *      quotes before commitment), the further investigations recommended, the risks, the
 *      reinstatement cost for buildings insurance. That is a letter to the client, and the
 *      client's answer is the physical-condition decision that holds exchange.
 */
import type { SurveyFacts, SurveyLegalIssue, SurveyRecommendation } from './types';

const pounds = (p: number) => `£${Math.round(p / 100).toLocaleString('en-GB')}`;
const bullet = (xs: string[]) => xs.map((x) => `• ${x}`).join('\n');
const clean = (t: string) => t.replace(/\s+/g, ' ').trim().replace(/[.;:,]+$/, '');

/** One enquiry to the seller's solicitor per legal-adviser point, in the words a conveyancer would use. */
export function surveyEnquiry(issue: SurveyLegalIssue): string {
  const point = clean(issue.text);
  if (issue.category === 'regulation') return `Our client's surveyor has raised the following: ${point}. Please supply copies of the planning permission and the building regulations approval and completion certificate for these works, or confirm that none was required and why.`;
  if (issue.category === 'guarantee') return `Our client's surveyor has raised the following: ${point}. Please supply the guarantee or warranty, with the original installer's details and confirmation that it is transferable to our client.`;
  return `Our client's surveyor has raised the following: ${point}. Please confirm the position and supply any documents that evidence it.`;
}

/** The client letter's blocks, filled from the survey. Empty strings where the report says nothing. */
export function surveyAdvice(f: SurveyFacts, opts: { purchasePricePennies: number | null; freehold: boolean; hasLender: boolean }): Record<string, string> {
  const recs = f.recommendations.filter((r) => r.code !== 'UNREAD');
  const urgent = recs.filter((r) => r.rating === 3 || (r.rating == null && r.severity === 'high'));
  const groups = investigationGroups(recs);
  const { seller: legal, ours } = sortLegalPoints(f.legalIssues ?? []);
  const risks = f.risks ?? [];
  const blocks: Record<string, string> = { urgentBlock: '', investigateBlock: '', legalBlock: '', riskBlock: '', valueBlock: '', insuranceBlock: '' };
  if (urgent.length) blocks.urgentBlock = `Your surveyor rates these as serious or urgent (condition rating 3):\n${bullet(urgent.map((r) => clean(r.text)))}\nRICS advises getting written quotations for this work before you are legally committed, which happens at exchange. You may want to use the quotes to ask the seller for a reduction or for the work to be done before completion.\n\n`;
  if (groups.length) blocks.investigateBlock = `Your surveyor recommends these inspections before you commit:\n${bullet(groups.map((g) => `${g.specialist}${g.items.length > 1 ? ` (${g.items.length} points in the report)` : `: ${clean(g.items[0].text)}`}`))}\nIf you want them done, tell us and we will ask the seller's solicitor for access. If you decide not to, please tell us in writing that you are proceeding without them.${groups.some((g) => g.specialist === 'Level 3 building survey') ? ' A Level 3 survey replaces much of the above with one detailed inspection; many buyers commission it first and then only the specialists it still recommends.' : ''}\n\n`;
  if (legal.length) blocks.legalBlock = `Your surveyor asked us, as your legal advisers, to check ${legal.length === 1 ? 'one point' : `${legal.length} points`} with the seller (planning and building regulations, guarantees, rights and boundaries). We are raising ${legal.length === 1 ? 'it' : 'them'} with the seller's solicitor and will report back.\n\n`;
  const insurance = ours.filter((o) => o.startsWith('Client: ')).map((o) => o.slice(8));
  if (insurance.length) blocks.riskBlock = `${blocks.riskBlock}Your surveyor also suggests you check:\n${bullet(insurance)}\n\n`;
  if (risks.length) blocks.riskBlock = `The report also notes these risks:\n${bullet(risks.map(clean))}\n\n`;
  if (f.marketValuePennies && opts.purchasePricePennies && f.marketValuePennies < opts.purchasePricePennies) blocks.valueBlock = `Your surveyor values the property at ${pounds(f.marketValuePennies)}, below the ${pounds(opts.purchasePricePennies)} you have agreed to pay.${opts.hasLender ? ' Your lender makes its own valuation, but a gap like this is worth raising with your broker.' : ''} It may also support a renegotiation.\n\n`;
  if (f.reinstatementCostPennies && opts.freehold) blocks.insuranceBlock = `For buildings insurance: the surveyor puts the reinstatement cost at ${pounds(f.reinstatementCostPennies)}. As the buyer of a freehold you are responsible for insuring the property from exchange, so please arrange cover from that date at no less than that figure.\n\n`;
  return blocks;
}

/** Whether the report gives the client anything to decide or the conveyancer anything to raise. */
export const surveyNeedsAdvice = (f: SurveyFacts): boolean => f.confidence > 0 && !f.recommendations.some((r) => r.code === 'UNREAD') && (f.recommendations.some((r) => r.rating === 3 || r.furtherInvestigation || r.severity === 'high') || (f.legalIssues?.length ?? 0) > 0 || (f.risks?.length ?? 0) > 0 || !!f.reinstatementCostPennies);

/** The specialist a recommendation needs, by what it is about: so ten sentences about damp are one damp specialist. */
const SPECIALISTS: Array<[RegExp, string]> = [
  [/level\s*3|building survey|full structural survey/i, 'Level 3 building survey'],
  [/asbestos/i, 'Asbestos surveyor'],
  [/\b(drain|drainage|cctv|sewer)/i, 'Drainage (CCTV) survey'],
  [/\b(gas|boiler|heating|hot water|cylinder|flue|hetas|wood ?burn|stove)/i, 'Gas and heating engineer'],
  [/\b(electric|niceic|napit|wiring|cabling|consumer unit)/i, 'Electrician'],
  [/\b(damp|timber|rot|woodworm|condensation|musty)/i, 'Damp and timber specialist'],
  [/\b(movement|crack|subsidence|structural|beam|joist|lintel|leaning|bulg|settle)/i, 'Structural engineer'],
  [/\b(roof|chimney|flashing)/i, 'Roofer'],
  [/\b(tree|arbor|root)/i, 'Arboriculturalist'],
  [/\b(plumb|pipework|water supply|leak)/i, 'Plumber'],
];
export function specialistFor(r: Pick<SurveyRecommendation, 'text' | 'specialist'>): string {
  const hay = `${r.specialist ?? ''} ${r.text}`;
  for (const [re, label] of SPECIALISTS) if (re.test(hay)) return label;
  return r.specialist?.trim() ? r.specialist.trim().replace(/^./, (c) => c.toUpperCase()) : 'Specialist';
}
/** Further-investigation recommendations grouped by the specialist who would do them. */
export function investigationGroups(recs: SurveyRecommendation[]): Array<{ specialist: string; items: SurveyRecommendation[]; urgent: boolean }> {
  const by = new Map<string, SurveyRecommendation[]>();
  for (const r of recs.filter((x) => x.furtherInvestigation && x.code !== 'UNREAD')) by.set(specialistFor(r), [...(by.get(specialistFor(r)) ?? []), r]);
  return [...by.entries()].map(([specialist, items]) => ({ specialist, items, urgent: items.some((r) => r.rating === 3 || (r.rating == null && r.severity === 'high')) }));
}
export const investigationTitle = (specialist: string) => `Further investigation: ${specialist}`;

const same = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').slice(0, 70);
/** Points for the seller's solicitor, and points we check ourselves (searches, the client's insurance): never both. */
export function sortLegalPoints(points: SurveyLegalIssue[]): { seller: SurveyLegalIssue[]; ours: string[] } {
  const seen = new Set<string>();
  const seller: SurveyLegalIssue[] = [];
  const ours: string[] = [];
  for (const p of points) {
    const k = same(p.text);
    if (seen.has(k)) continue;
    seen.add(k);
    if (/insur/i.test(p.text)) ours.push(`Client: ${clean(p.text)}`);
    // What the searches answer (ground, mining, flood, radon, the council tax band, road adoption), not what the seller must produce.
    else if (/(council tax|made ground|mining|flood|radon|\bsearch|adopted|adoption)/i.test(p.text) && !/(vendor|seller|approval|consent|certificate|permission)/i.test(p.text)) ours.push(`Searches: ${clean(p.text)}`);
    else seller.push(p);
  }
  return { seller, ours };
}
const ASK: Record<SurveyLegalIssue['category'], string> = {
  regulation: 'Please supply the planning permission and building regulations approval and completion certificate, or confirm none was required and why.',
  guarantee: 'Please supply the guarantee or certificate and confirm it is transferable.',
  other: 'Please confirm the position and supply any documents that evidence it.',
};
/** One set of additional enquiries arising from the survey, numbered, as a conveyancer sends them. */
export function surveyEnquiries(points: SurveyLegalIssue[]): string | null {
  if (!points.length) return null;
  return [`Additional enquiries arising from our client's survey:`, ...points.map((p, i) => `${i + 1}. ${clean(p.text)}. ${ASK[p.category]}`)].join('\n');
}
/** One request for access, naming each specialist and what they are to look at. */
export function accessEnquiry(groups: Array<{ specialist: string; items: Array<{ text: string }> }>, note?: string | null): string {
  return [
    `Our client wishes to have the following inspections carried out before exchange, as recommended by their surveyor. Please confirm your client will permit access, on what dates, and on what conditions (including whether any lifting of floor coverings or minor opening-up is acceptable and who makes good):`,
    ...groups.map((g, i) => `${i + 1}. ${g.specialist}: ${g.items.slice(0, 3).map((x) => clean(x.text)).join('; ')}${g.items.length > 3 ? `; and ${g.items.length - 3} related point${g.items.length - 3 === 1 ? '' : 's'}` : ''}.`),
    ...(note ? [`Our client adds: ${note}`] : []),
  ].join('\n');
}

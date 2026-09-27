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
import type { SurveyFacts, SurveyLegalIssue } from './types';

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
  const urgent = f.recommendations.filter((r) => r.rating === 3 || (r.rating == null && r.severity === 'high'));
  const investigate = f.recommendations.filter((r) => r.furtherInvestigation);
  const legal = f.legalIssues ?? [];
  const risks = f.risks ?? [];
  const blocks: Record<string, string> = { urgentBlock: '', investigateBlock: '', legalBlock: '', riskBlock: '', valueBlock: '', insuranceBlock: '' };
  if (urgent.length) blocks.urgentBlock = `Your surveyor rates these as serious or urgent (condition rating 3):\n${bullet(urgent.map((r) => clean(r.text)))}\nRICS advises getting written quotations for this work before you are legally committed, which happens at exchange. You may want to use the quotes to ask the seller for a reduction or for the work to be done before completion.\n\n`;
  if (investigate.length) blocks.investigateBlock = `Your surveyor recommends further investigation before you commit:\n${bullet(investigate.map((r) => `${clean(r.text)}${r.specialist ? ` (${r.specialist})` : ''}`))}\nIf you want these done, tell us and we will ask the seller's solicitor for access. If you decide not to, please tell us in writing that you are proceeding without them.\n\n`;
  if (legal.length) blocks.legalBlock = `Your surveyor asked us, as your legal advisers, to check ${legal.length === 1 ? 'one point' : `${legal.length} points`}:\n${bullet(legal.map((l) => clean(l.text)))}\nWe are raising ${legal.length === 1 ? 'it' : 'these'} with the seller's solicitor and will report back.\n\n`;
  if (risks.length) blocks.riskBlock = `The report also notes these risks:\n${bullet(risks.map(clean))}\n\n`;
  if (f.marketValuePennies && opts.purchasePricePennies && f.marketValuePennies < opts.purchasePricePennies) blocks.valueBlock = `Your surveyor values the property at ${pounds(f.marketValuePennies)}, below the ${pounds(opts.purchasePricePennies)} you have agreed to pay.${opts.hasLender ? ' Your lender makes its own valuation, but a gap like this is worth raising with your broker.' : ''} It may also support a renegotiation.\n\n`;
  if (f.reinstatementCostPennies && opts.freehold) blocks.insuranceBlock = `For buildings insurance: the surveyor puts the reinstatement cost at ${pounds(f.reinstatementCostPennies)}. As the buyer of a freehold you are responsible for insuring the property from exchange, so please arrange cover from that date at no less than that figure.\n\n`;
  return blocks;
}

/** Whether the report gives the client anything to decide or the conveyancer anything to raise. */
export const surveyNeedsAdvice = (f: SurveyFacts): boolean => f.recommendations.some((r) => r.rating === 3 || r.furtherInvestigation || r.severity === 'high') || (f.legalIssues?.length ?? 0) > 0 || (f.risks?.length ?? 0) > 0 || !!f.reinstatementCostPennies;

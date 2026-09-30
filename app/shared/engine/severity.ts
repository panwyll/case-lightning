/**
 * Issue severity as the person sees it: a RAG colour and a word. The engine's scale is
 * info / warning / critical (issues.ts); it sets each issue's urgency on the Tasks list (work.ts).
 */
export type Severity = 'info' | 'warning' | 'critical';
export const SEVERITIES: Severity[] = ['critical', 'warning', 'info'];
export const SEVERITY_LABEL: Record<Severity, string> = { critical: 'High', warning: 'Medium', info: 'Low' };
/** Red / amber / green. */
export const SEVERITY_CSS = `
.sev{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;border-radius:999px;padding:2px 8px;white-space:nowrap}
.sev::before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor}
.sev.critical{color:#b91c1c;background:#fee2e2}
.sev.warning{color:#92400e;background:#fef3c7}
.sev.info{color:#166534;background:#dcfce7}
`;

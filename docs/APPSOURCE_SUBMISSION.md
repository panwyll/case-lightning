# Publishing CaseLightning to AppSource

How to list the CaseLightning Outlook add-in on Microsoft AppSource (the Microsoft
commercial marketplace) via Partner Center. AppSource is for **public discovery and
distribution to many firms** — it is *not* required to use the add-in internally
(that's central deployment via the M365 admin center → Integrated apps) and it does
**not** bypass a tenant admin's control over which add-ins are allowed.

The deployed manifest is `public/addin/manifest.xml` (URLs point at
`https://www.caselightning.co.uk`). Same `<Id>` is reused across deployments so it's
treated as one app.

## Pipeline at a glance

1. Partner Center commercial-marketplace account (one-time; business verification)
2. Create an **Office Add-in** offer + store listing
3. Submit → Microsoft **certification / validation** (~3–5 business days)
4. Publish (optionally to a private **preview audience** first)
5. (Optional) **Microsoft 365 Certification** — deeper security attestation
6. Maintain: every update re-runs validation; keep hosted endpoints up

No annual developer fee (unlike Apple's App Store).

## 1. Partner Center account

- Enrol in the **commercial marketplace** program at partner.microsoft.com.
- Requires a **verified legal business identity** (company details; often a
  **D-U-N-S number**). Verification can take several days — start this first.
- Set up the **publisher profile** (publisher display name shown on the listing).

## 2. Offer + listing assets

Create a new offer of type **Office Add-in** and provide:

- [ ] **Production-hosted manifest** (`public/addin/manifest.xml`, prod URLs) — all
      URLs must be HTTPS and reachable.
- [ ] **Name** + **short/long description** (no unverifiable superlatives).
- [ ] **Category** (e.g. Productivity / Legal) and **industries**.
- [ ] **Logos** (store logo + the manifest icons already served at
      `/addin/icon-*.png`).
- [ ] **Screenshots** (1–5) and optionally a **demo video**.
- [ ] **Privacy policy URL** (public, hosted — see outline below).
- [ ] **Terms of Use / EULA** (public, hosted, or use Microsoft's Standard Contract).
- [ ] **Support contact** + **support URL** (currently `/how-it-works`; a dedicated
      `/support` with contact + SLA reads better to reviewers).
- [ ] **Reviewer test account + test notes** — working credentials Microsoft's
      testers can sign into. CRITICAL for CaseLightning: the account must have a
      real Exchange Online mailbox AND a SharePoint/OneDrive licence, or the
      reviewer can't exercise mail reading or matter provisioning. Provide a step
      list (connect → link/create matter → summarise → draft) and seed a couple of
      conveyancing-style emails.

## 3. Certification / validation

Microsoft runs automated + manual checks against the Commercial Marketplace
certification policies and the Office Store validation policies:

- Manifest validity; **HTTPS everywhere**; no console errors; reasonable performance.
- **Functional test** with the reviewer account (so the test mailbox must work).
- Accessibility, content, and security/privacy review.
- Expect **email back-and-forth**; each resubmission restarts the ~3–5 day clock.

Pre-submission self-check:
- [ ] Validate the manifest (`npx office-addin-manifest validate public/addin/manifest.xml`).
- [ ] Load the taskpane at the prod URL with devtools open — **zero console errors**.
- [ ] Confirm every manifest URL returns 200 over HTTPS.
- [ ] Walk the full flow on a licensed test tenant end-to-end.

## 4. Publish

- Once certified you choose to go live; it appears on appsource.microsoft.com and in
  the in-product store.
- Use a **preview audience** (specific AAD tenants/emails) to validate the live
  listing privately before public release.

## 5. (Optional) Microsoft 365 Certification

A separate, deeper **security & compliance attestation**. Not required to list, but
it builds admin trust and some buyers filter for it. Worth pursuing given the data
sensitivity below.

## Privacy policy outline (UK conveyancing / GDPR)

CaseLightning processes **client personal data and email content** through a backend
(Next.js on Vercel), a database (Supabase/Postgres), Microsoft Graph, and an LLM
provider. The privacy policy must be specific about this. Cover:

- **Who we are / controller vs processor** — for firms using it, the firm is the
  controller; CaseLightning is a processor acting on their instructions.
- **What data is processed** — email subjects/bodies/attachments, matter facts,
  party names/addresses, OneDrive documents, OAuth tokens, usage metering.
- **Why / lawful basis** — performance of contract; legitimate interests; the firm's
  basis for the underlying client data.
- **Sub-processors** — Microsoft (Graph/365), Vercel (hosting), Supabase (data),
  and the **AI/LLM provider** — name them and link their terms. State whether email
  content is sent to the LLM and whether it's used for training (it must not be).
- **Data location / transfers** — where data is stored/processed; any transfers
  outside the UK/EEA and the safeguards (SCCs etc.).
- **Retention** — how long matter data, email chunks, tokens and logs are kept, and
  deletion on request / off-boarding.
- **Security** — encryption in transit/at rest, tenant isolation, access controls,
  audit logging (the app already writes an audit trail).
- **Data subject rights** — access, rectification, erasure, how to exercise them.
- **Draft-only guarantee** — the add-in never sends email on the user's behalf;
  it only creates drafts. Worth stating explicitly; it lowers perceived risk.
- **Contact / DPO** and complaint route (ICO).

## EULA outline

- Licence grant + restrictions (no resale/reverse-engineering).
- Acceptable use; account/security responsibilities.
- **AI output disclaimer** — drafts/summaries are assistive, not legal advice;
  the conveyancer remains responsible for reviewing every draft before sending.
- Availability / no-warranty / liability limits.
- Data processing terms (reference the privacy policy / a DPA for firms).
- Termination and data return/deletion on termination.
- Governing law (England & Wales).

## Reality checks

- **Admins still gate it.** Even once public, a firm's M365 admin decides whether
  AppSource add-ins are allowed/deployed — same control used for the internal rollout.
- **It needs a licensed mailbox + SharePoint/OneDrive to function** — surface clear
  errors when those are missing (already done for the mailbox 401 and the SPO 400
  via `describeGraphError`).

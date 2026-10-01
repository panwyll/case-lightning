# Cyber Essentials audit: 1 October 2026

Measured against the five controls in [cyber-essentials.md](cyber-essentials.md).

**What was checked:**
- This Mac, read-only.
- The codebase and its dependencies.
- The live site's headers.
- The production database's roles, read-only.
- What the GitHub CLI can see.

Cloud consoles were not reachable, so their checks are listed for Peter to do.

Key: **Fixed**, done in this audit · **Pass** · **Action**, Peter to do · **Plan**, scheduled with a reason.

## 1 · Firewalls

| Check | Result |
|---|---|
| Mac firewall | **Action**: it is **off** (`socketfilterfw` state 0). Turn it on in System Settings → Network → Firewall, and turn on stealth mode in its options. With it off, AirPlay (ports 5000/7000) and Continuity (rapportd) listen to the whole network. |
| Router admin password changed from the default; no ports forwarded | **Action**: check on the router. |
| Only the hosting providers face the internet | **Pass**: the app runs on Vercel; the database is Supabase-managed. |

## 2 · Secure configuration

| Check | Result |
|---|---|
| Disk encryption | **Pass**: FileVault is on. |
| Gatekeeper / System Integrity Protection | **Pass**: both enabled. |
| Screen lock | **Pass**: password required immediately on lock. Also set the display to sleep after 5 minutes or less, if it is not already. |
| Unused accounts | **Pass**: one user account on the Mac. |
| Secrets in the code repository | **Pass**: no keys or tokens in tracked files; `.env*.local` is ignored, and only `.env.example` is tracked. |
| Security headers on the site | **Fixed** (`next.config.ts`), verified on a production build: content-type sniffing off and a strict referrer policy on every page; no referrer at all and no framing on the client's pages (`/pof`, `/f`, whose address carries their secret link); the app framed only by itself. The Outlook add-in's pages are left frameable. HTTPS-only (HSTS) was already on. |
| Session cookies | **Pass**: inaccessible to scripts, HTTPS-only, cross-site protected, 7-day expiry. |

## 3 · Security update management (14 days for high and critical)

| Check | Result |
|---|---|
| macOS updates | **Pass**: macOS 26.4.1, with automatic download, macOS updates and security responses all on. App Store auto-update is on. |
| App dependencies: high and critical | **Fixed**: 1 critical and 5 high found. Next.js was updated within 15.x (critical: a denial of service in Server Components), along with `ws`, `nanoid` and `@xmldom/xmldom`. `sharp` went to 0.35.5: its libvips and libheif flaws were reachable through client photo uploads (HEIC). Tests, build and a real image conversion all pass. |
| Remaining | **Plan**: PostCSS inside Next.js (high, plus one moderate) is fixed only by **Next 16**, a major upgrade. PostCSS runs only at build time, never on the live site, so it is not reachable by a user. Schedule the Next 16 upgrade as its own piece of work within the month. |
| Ongoing | **Action**: turn on Dependabot alerts and security updates in the GitHub repository settings, so fixes arrive as pull requests. |

## 4 · User access control

| Check | Result |
|---|---|
| Daily use of an admin account | **Action**: the Mac's only user, `peteranwyll`, is an **administrator**. Cyber Essentials expects day-to-day work in a standard account: create a separate admin account and make `peteranwyll` a standard user, or accept and record the risk if the assessor allows it for a one-person business. |
| Multi-factor sign-in on every cloud service | **Action**: MFA could not be read from here (the GitHub CLI token cannot see it). Turn it on and confirm, with an authenticator app rather than text message where offered, for: **GitHub** (the CLI is signed in as `panwyll` while commits are as `killerdotdev`, so check both), **Vercel**, **Supabase**, **Microsoft 365 / Entra**, **Google Workspace**, **Resend**, **Stripe**, **Anthropic**, **Groq**, **OpenAI / Voyage**, **TrueLayer**, **InfoTrack / LEAP / InTouch consoles**, and the **domain registrar and DNS**. |
| Least privilege: the database | **Action (important)**: the app's production database login very likely bypasses row-level security. The health check reports `wallEnforced: false`, and every role that can log in except Supabase's own has `BYPASSRLS` (`postgres`, `supabase_read_only_user`, `claude_readonly`). The ethical wall between handlers of linked matters is therefore not enforced by the database on prod. **Fix:** create an app role without `BYPASSRLS` that keeps the grants the app needs, switch `DATABASE_URL` to it, and confirm the health check reports `wallEnforced: true`. Test on a branch database first: the automation paths (`runAsSystem` / `runAsAutomation`) must be checked under it. |
| Read-only production access | **Pass**: `claude_readonly` can only SELECT. It does bypass row-level security, which is by design for reading every firm's data in support work; keep its password out of the repository (it is). |
| App sign-in | Microsoft sign-in inherits the firm's own MFA. One-time email links are single-factor (whoever controls the mailbox). Acceptable for Cyber Essentials, which covers our accounts, not our customers'; worth offering "Microsoft sign-in only" per firm later. |
| Leavers and quarterly access review | **Action**: one person today; write down the process (what to revoke and where) before the first hire. |

## 5 · Malware protection

| Check | Result |
|---|---|
| Mac | **Pass**: built-in protection (XProtect and Gatekeeper) is on, and macOS updates install automatically. Confirm the assessor accepts the built-in protection under the current requirements; otherwise add anti-malware. |
| Phones used for work | **Action**: apps only from the official stores, a 6-digit passcode or biometrics, and automatic updates on. |

## Also found (not Cyber Essentials, but asked about by firms)

- **Email spoofing protection:** DMARC is `p=none`. Once Resend's mail shows as passing in the reports, move to `p=quarantine`.
- **Data held abroad:** the database is in Frankfurt (EU, adequate). AI providers are in the US: they need the UK–US data bridge or the IDTA, and zero data retention where offered.
- **Penetration test:** none yet. Book one alongside Cyber Essentials Plus.

## To do, in order

1. Turn on the **Mac firewall** (2 minutes).
2. **MFA everywhere** in the list in §4 (an afternoon).
3. A **standard user account** for daily work (30 minutes).
4. **Dependabot** alerts and security updates on (2 minutes).
5. The **database app role** without `BYPASSRLS` (a planned change, tested first).
6. The **Next 16** upgrade (this month).
7. The **router** check, and **phone** settings.
8. Then answer the Cyber Essentials questionnaire.

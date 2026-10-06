# Workload Baseline

How much of a conveyancer's week goes on email that does not need a conveyancer, measured from their own mailbox before CONVEYi, and how much of it CONVEYi has taken since. Page: `/conveyi/baseline` (sidebar: Cases → Baseline). Code: `lib/server/workload/`.

## Why

The conveyancer is the constraint on a firm's revenue: completions are capped by conveyancer hours, and conveyancers are paid per completion. An hour a conveyancer spends on work that does not need one (a chaser, a status update, sending a copy of a file) is an hour of completions the firm and the conveyancer do not get back (Goldratt, *The Goal*: an hour lost at the bottleneck is an hour lost to the whole system). That work is high in frequency and low in severity, so nobody counts it. This counts it, from their own email, with every step shown so it can be checked.

## What it says

For one conveyancer, from a scan of their mailbox:

> We read 3,512 emails from 6 July to 5 October (13 working weeks). You wrote 1,204 of them. 312 were chasers, 288 status updates, 141 answers to "any news?", 96 files sent on, 74 acknowledgements. Typing those alone takes 3.9 hours a week. With finding what to say, by your own estimate and by Outlook's timings, it is 11.6 hours a week: 31% of a 37.5-hour week, 22% of it after hours. CONVEYi sends all of these. 11.6 hours a week is 2.3 more completions a month at 21 hours a completion: £2,070 to the firm and £460 to you, a month.

Then, after go-live, the same measures from what CONVEYi actually sent, and from a re-scan of the conveyancer's own Sent Items.

## Method

### 1. The scan

- **Read:** Sent Items (the work done) and the Inbox (the requests that cause it), over a window the conveyancer chooses (default the last 13 weeks), up to 5,000 messages.
- **Per message, read once and not kept:** the part of the body this message added (Graph `uniqueBody`, so quoted replies below it are not counted), the subject, who it went to and when.
- **Kept, one row per message:**
  - direction;
  - when the draft was created and when it was sent;
  - the words written (the added part, without the signature);
  - the recipients' roles;
  - whether it is a reply or a forward, and whether it had attachments;
  - the thread id, category, confidence and how it was classified.
  
  No text is kept. The email stays in Outlook and opens from the row.
- **Filtered by rule before any model sees it:** automated and bulk mail (no-reply senders, notifications, newsletters, calendar responses), and empty bodies. These are counted, not classified.

### 2. Categories

Each message the conveyancer sent is put in exactly one category. The **tier** says what CONVEYi does with that kind of email.

| Category | What it is | Tier |
| --- | --- | --- |
| Chaser | Asking again for something already asked for or overdue | Sent by CONVEYi |
| Status update | Telling someone where the case stands, unprompted | Sent by CONVEYi |
| Answer to "any news?" | Replying to someone asking for an update | Sent by CONVEYi |
| First request | Asking for something for the first time: ID, forms, funds, documents, figures | Sent by CONVEYi |
| File sent | Sending a document or a copy someone needs | Sent by CONVEYi |
| Acknowledgement | Confirming something arrived | Sent by CONVEYi |
| Scheduling | Arranging calls, appointments, dates, completion logistics | Drafted by CONVEYi |
| Client question | Answering a client's question about the process or their case (not "any news?") | Drafted by CONVEYi |
| Legal work | Enquiries and replies, advice, reports, contract points, negotiation, undertakings | The conveyancer's |
| Internal | To colleagues at the firm | Not counted |
| Not case work | Anything else | Not counted |

Received messages are categorised the same way, by what they ask of us: update requests, chasers received, documents delivered, questions, instructions, enquiries, other.

The classifier is the classify-tier model (`ai.ts classifyWorkload`). It reads ten messages at a time, with the role of each recipient and the first 1,200 characters of the added text. Each result records the model, the prompt version and a confidence.

### 3. Accuracy

At the end of the scan the conveyancer checks 50 of their sent emails, drawn at random. Each one opens from Outlook beside the category it was given, and they agree or pick the right category.

- **Agreement** is reported with its 95% Wilson interval, for example "47 of 50 agreed (94%, 84% to 98%)".
- **The counts are corrected for the errors found.** For each category the model gave, the sample shows how often it was really each category, and every count is re-spread by those rates.
  - With 50 checked across eleven categories, a category may have only two or three checked. So each category's rates are shrunk towards the whole sample's (empirical Bayes, with a prior weight of 5 checked emails): agreement at the overall rate, and mistakes spread the way the overall mistakes went.
  - A category with many checked follows its own errors; one with none follows the overall.
  - Counts are only re-spread, never added or removed.
  - The report shows both the classified and the corrected counts.
- **Until the sample is checked**, the report says it is unchecked and shows raw counts.

### 4. Time

Each kind of email gets a time per email, with its basis stated beside it:

| Measure | How | Basis |
| --- | --- | --- |
| **Typing (floor)** | Words written ÷ typing speed. Default 40 words a minute, a fluent typist copying text. Writing your own words is slower (about 19 wpm in Karat et al., CHI 1999), so this undercounts. | Fully reproducible from the rows |
| **Finding what to say** | Per category: the conveyancer's own estimate of the minutes spent looking things up before writing (opening the file, checking the case management system, reading the thread). | Their estimate |
| **Timed** | Outlook's own timings: the minutes from the draft being created to it being sent, for messages written in Outlook. The middle of the distribution is used (median, ignoring under 15 seconds and over 45 minutes as left-open drafts). Once a category has at least 10 timed messages, its timed median replaces typing plus estimate. | Measured, per category |

The central figure for each category is:
- the timed median, where there are at least 10 timed messages;
- otherwise typing plus the conveyancer's estimate;
- otherwise typing alone, marked "estimate pending".

The floor is always shown beside it.

Not counted, to keep it defensible:
- the cost of being interrupted;
- reading the message that prompted a reply;
- phone calls.

The timed figure cannot see work done before the draft was opened, so it undercounts too.

### 5. The week

- **Per week:** count ÷ working weeks in the window. A working week is five working days on the England and Wales calendar, with bank holidays left out.
- **Hours a week** per category = per week × minutes ÷ 60. Shown as a share of the contracted week, 37.5 hours by default (set per firm).
- **In hours and after hours:** each sent message's time against the firm's working day (default 09:00 to 17:30, Monday to Friday, UK time).

### 6. Money

The firm's own figures (Firm → Details → Baseline):
- hours a completion takes;
- fee per completion;
- the conveyancer's pay per completion, optional.

The calculation:
- **Freed hours a week** = central hours for the "Sent by CONVEYi" tier, plus typing time only for the "Drafted by CONVEYi" tier.
- **Freed hours a month** = freed hours a week × 52 ÷ 12.
- **Extra completions a month** = freed hours a month ÷ hours per completion.
- **Firm revenue a month** = extra completions × fee. **Conveyancer's pay a month** = extra completions × pay per completion.

This is capacity, not a forecast: it assumes the work is there to fill the hours, and says so.

### 7. After go-live

- **What CONVEYi did:** the chases, updates, requests, acknowledgements and files it sent on the conveyancer's cases each week (`matter_event`), × the same minutes per email = hours handed over a week.
- **What changed in the mailbox:** a re-scan of Sent Items, the same method on the weeks since go-live, against the baseline scan. This is hand-written chasers a week before and after, the strongest proof that the work moved.

## Reproducibility

Everything in the report is computed from the stored rows and the settings shown under it (`lib/server/workload/model.ts`, a pure function, unit-tested). Change a setting and the report recomputes. The scan's settings, model and prompt version are kept with it.

## Privacy

- A conveyancer scans their own mailbox (delegated access, Mail.Read).
- No message text is stored. A message is read only while it is being classified, and again only when the conveyancer opens it to check.
- An admin sees the firm's totals and each person's report. The rows (subjects open from Outlook) are visible only to the person whose mailbox it is.

# Filing email to cases

The web app has an email view again. It is **not an inbox**, and the distinction is the
whole point.

A conveyancer already has an inbox, and it is better than anything we would build. What
they do not have is a reliable answer to "is every email on the right case?" — which is
the question that decides whether the engine can see the transaction at all. A document
attached to an unfiled thread is a document the case does not know exists.

So the view asks one question per email — **which case is this?** — and the row leaves
the moment it is answered. The list is meant to reach zero.

## What is deliberately absent

No read/unread. No folders. No reply, no forward, no archive, no delete. No search across
the mailbox. Every one of those makes it a worse inbox than Outlook and distracts from the
only job it has.

"Not case email" does **not** delete, archive or move anything. The email is the firm's,
in the firm's mailbox, and a filing tool has no business touching it. It records that
somebody looked, so the queue stops offering that thread — and deleting the row puts it
straight back.

## What is in the queue

Everything in the inbox that is not already answered for:

* threads already filed to a matter are gone (`email_thread`);
* threads someone has set aside are gone (`email_not_filed`);
* what is left carries the best matter matches we can find.

## The suggestions

Matching is **deterministic**: case reference tokens, the firm's own ref, participant
addresses, the property's house number and street ("9 Arthur Road contract pack"), its
postcode, and client names (`lib/server/matching.ts`, `lib/server/mail/address-match.ts`).
It is not AI. Scrolling a queue must never cost a model call or burn the firm's monthly
cap, which is the same rule `/api/v1/mail` already follows. It reads the whole body as
plain text, not only the preview.

**A case is shown the way a person recognises it, not by its reference.** Nobody looks
at "9 Arthur Road contract pack" and thinks "SOO-10202". Each suggestion is a card
(`lib/server/mail/case-cards.ts`):

- the property address, with the reference small beside it;
- "Purchase for Priya Shah · Searches & enquiries · Alice Okafor · other side Bartlett & Co";
- the engine's score as a percentage, coloured by its verdict: green for AUTO (a linked
  thread, our reference, or two independent signals agree), amber for STRONG, red for WEAK;
- **what matched**, in words: "Mentions 9 Arthur Road", "From Sarah Bartlett, the other
  side's solicitor on this case", "Mentions Priya Shah".

The page is a list and one email in hand. On the left is what is left to file, each with
its best case (a coloured dot, the street, the client). On the right is the selected
email: its cases, the actions, and the email itself to read. Filing moves on to the
next. Up and down (or j / k) move through the list.

**Mail that is not about a case** (newsletters, notifications) is set apart in a
collapsed "Probably not case mail" group with "Set all aside"
(`lib/server/mail/bulk.ts`). The mailing systems say so themselves (List-Unsubscribe,
List-Id, Precedence: bulk, Auto-Submitted), or the address does (no-reply, news@...). It
is only set apart when nothing ties it to a case: a notification that clearly matches
one stays in the queue. The sender check is not shown on it.

A forwarded email previews what it actually says, not the "From: … Sent: …" block, and
names who it was forwarded from.

Two cases at the same address in different towns score the same. The card is what tells
them apart. Up to three are shown, and "A different case…" searches by address, client
or reference and shows the same details. "Open" shows the whole email inline, in a
sandbox with no scripts and no remote content.

## The sender is checked before it counts

Conveyancing is the most targeted sector for email fraud. A sender only counts as
evidence of which case an email belongs to once it has passed
`lib/server/mail/sender-check.ts`:

1. **Authentication**: the receiving server's DMARC / SPF / DKIM / compauth verdict,
   from the Authentication-Results headers.
2. **Look-alike domain**: one character off, a swapped glyph (1/l, 0/o, rn/m, vv/w), a
   dropped hyphen or a different ending (.co for .co.uk) from any domain the firm deals
   with.
3. **Borrowed name**: the display name is a known contact or colleague, but the address
   is not theirs.
4. **Diverted replies**: the email claims to be from someone we deal with (their
   organisation, a look-alike of it, or a known name), but Reply-To goes to a different
   organisation. Domains are compared by organisation, so a newsletter from
   mails.microsoft.com with replies to microsoft.com is fine, and a sender we have never
   dealt with impersonates nobody we know.

Any of these makes the row show a red "Check this sender before acting on it" box, with
the reasons in plain words. The sender's From, To and Cc then do not count towards the
match, and the match can never be green, whatever else agrees.

## What filing actually does

It is the existing link-thread path, unchanged: the thread is linked to the matter,
categorised in Outlook with the matter's own reference so it is visibly filed there too,
and its attachments are saved into the matter — where the ordinary ingest picks them up
and the engine sees them. Filing an email is how a search result or a mortgage offer
reaches the case.

## Where it lives

**/conveyi/email**, linked from Today, the caseload and My work. Behind the sign-in wall
like every other app page.

![The filing queue](demo/34b-email-filing.png)

*(The page is the real one; the mailbox behind it is sampled, because the build
environment has no Microsoft 365 connection.)*

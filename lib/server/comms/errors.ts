/**
 * A send that failed, explained for the person who has to fix it: what went wrong in plain
 * words and the steps that put it right. The raw error text is kept underneath for support.
 */
export interface SendFailure { reason: string; steps: string[]; raw: string }

export function explainSendError(err: unknown): SendFailure {
  const raw = (err instanceof Error ? err.message : String(err)).trim();
  const m = (re: RegExp) => re.test(raw);
  const held = raw.match(/^Not sent: the message looks wrong \((.+?)\)\./);
  if (held) return { reason: `The message was held back because ${held[1]}. Nothing was sent.`, steps: ['Read the message below and correct what is wrong', 'Send it yourself from Outlook, or fix the case (read the document again, fill the missing detail) and use Try Again'], raw };
  const reconnect = ['Open the Team page and use Connect Microsoft 365 (if it still fails, "Reconnect with fresh permissions": /api/v1/auth/login?consent=1), signing in as the fee earner on this case', 'Come back to Tasks and approve the message again'];
  if (m(/Graph account not connected|Refresh token missing|reconnect required|InvalidAuthenticationToken|token.*(expired|invalid)|AADSTS|\b401\b|Unauthori[sz]ed|consent/i)) {
    return { reason: 'Your Microsoft 365 connection has expired or been revoked, so the mailbox could not send.', steps: reconnect, raw };
  }
  if (m(/No fee-earner mailbox|No email sender configured|no sender configured|mailbox not connected/i)) {
    return { reason: 'No sending mailbox is connected for the fee earner on this case.', steps: reconnect, raw };
  }
  if (m(/No client channel|no email address|No .* email address|no address on the (case|matter)|add the contact/i)) {
    return { reason: 'There is no email address (or opted-in WhatsApp number) for them on this case.', steps: ['Add their email address to the case (Case View → the contacts)', 'Approve the message again'], raw };
  }
  if (m(/bounce|does not exist|no such user|mailbox unavailable|recipient rejected|undeliverable|address rejected/i)) {
    return { reason: `The address rejected it: ${raw.replace(/[.!]*$/, '')}.`, steps: ['Check the address on the case (Contacts on the case view) and correct it', 'Then send it again'], raw };
  }
  if (m(/complain|spam report|marked as spam/i)) {
    return { reason: 'The recipient reported it as spam, so nothing further will go to that address by email.', steps: ['Speak to the client and agree how they want to hear from us', 'Update the contact on the case'], raw };
  }
  if (m(/\b429\b|throttl|rate limit|too many requests/i)) {
    return { reason: 'Microsoft is rate-limiting the mailbox for the moment.', steps: ['Wait ten minutes and approve the message again'], raw };
  }
  if (m(/ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|network|\b50[0-9]\b|Service Unavailable|Bad Gateway/i)) {
    return { reason: 'The mail service could not be reached.', steps: ['Try again in a few minutes by approving the message again'], raw };
  }
  return { reason: `The message could not be sent: ${raw.replace(/[.!]*$/, '')}.`, steps: ['Approve the message again; if it fails the same way, send it yourself and report the error text below'], raw };
}

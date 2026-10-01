# InfoTrack

InfoTrack is where searches, official copies and ID checks are ordered. CONVEYi orders them **on each firm's own InfoTrack account**: billed to the firm, visible in its InfoTrack, and in its LEAP or InTouch where InfoTrack is linked to them.

## Connecting (Tools → InfoTrack)

An admin enters the credentials InfoTrack issued the firm:

| Field | Notes |
| --- | --- |
| **API Address** | Required, https. |
| **Token Address** | Optional. Defaults to `<API Address>/oauth/token`. |
| **Client ID** and **Client Secret** | Required. Client credentials. |
| **Signing Secret** | Optional. When InfoTrack signs result deliveries (`x-infotrack-signature`, HMAC-SHA256), every delivery must match it. |

How connecting works:
- The details are saved encrypted (`infotrack_connection`, migration 120). A failed attempt keeps what was typed and says why.
- A token is then requested to prove the details. Only a successful token marks the firm Connected.
- Saved secrets are never shown again. Leaving a secret blank keeps the saved one.
- Connecting and disconnecting are audited.

**Results URL:**
- Each firm has its own: `/api/v1/integrations/infotrack/webhook?firm=<firm>&key=<key>`. We generate the key once and keep it encrypted.
- The URL is sent with every order, so nothing needs setting in InfoTrack. It is shown on the page for reference.
- A delivery is accepted only when:
  - the key matches (constant-time comparison);
  - the signature matches, if the firm has a signing secret;
  - the order belongs to that firm.
- From the body we take only the order reference and the document link. The matter and sub-flow come from our own order record.

**Disconnect:**
- New orders stop at once.
- Results of orders already placed are still accepted, since they are paid for.
- The saved details stay, so reconnecting is one click.

## Without an account

A firm that has not connected InfoTrack gets the stand-in (`FirmInfoTrackRouter`):
- Each search comes straight back as a **placeholder**. It says on its face that no search was done and tells the conveyancer to order the real one before exchange.
- ID checks fall back to our own request to the client.

Stand-in orders carry a `STANDIN:` reference, so a placeholder is never produced for a real order. A firm's real orders, in turn, never go through another firm's account.

## Ordering

| Engine step | InfoTrack order |
| --- | --- |
| Search ordered | `POST /v1/orders/searches`, with the product code from `SEARCH_PRODUCT` |
| ID check (client) | `POST /v1/orders/aml-id-checks`, with the client's name, email and phone |
| ID check (named party: co-buyer, donor, attorney) | The same order in **their** name. The client's contact details are not sent. |

Each order is recorded in `integration_order` and listed on the InfoTrack page.

## With LEAP or InTouch

Where the firm's InfoTrack is linked to its practice system, InfoTrack also files each result there, and our mirror brings it in. Whichever copy arrives first is used; the second is recorded against the order and goes no further.

## Still assumed

The endpoint paths and payload field names (`ENDPOINTS`, `SEARCH_PRODUCT` and the mappers in `lib/server/integrations/infotrack.ts`) follow InfoTrack's published shape. They are to be confirmed against the partner specification on onboarding, and all of them live in that one file.

The `INFOTRACK_*` environment variables remain only as a fallback for a deployment that serves a single firm.

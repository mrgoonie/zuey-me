/** Public, non-personalized purchase guide for AI agents served at /checkout.md. */
export function renderCheckoutMarkdown(origin: string): string {
  const o = origin.replace(/\/$/, '');
  return `# Zuey checkout guide for AI agents

> Purpose: help your human **pay** for a Zuey membership, course or consultation. You never pay for them, never collect payment credentials, and never accept terms on their behalf. Plans, prices and availability are computed by the live backend; do not quote them from memory or from this page.

Site: ${o} · Agent index: ${o}/llms.txt

## If the user asks you to buy

1. Identify the product (membership plan, course or consultation) and fetch its **current** price from the live source below.
2. Tell the user the product, term and price, and ask for an explicit "yes" before creating anything.
3. Pick the path:
   - **No connected tools (default):** give the user the official browser link for the product. They sign in and pay on ${o}.
   - **Connected with OAuth/key scopes (\`checkout:write\` to create, \`billing:read\` to read status):** create the order through MCP or REST, then give the user the returned \`checkout_url\` or \`transfer.qr_url\`.
4. The human pays on the provider, bank or website.
5. Connected agents poll **their own** order and report success only when the backend says \`paid\`.

## Membership

- Plan IDs: \`knowledges\`, \`ai\`, \`combo\`, \`community\`. Prepaid terms (bank transfer): \`1\`, \`3\`, \`6\`, \`12\` months. Card subscriptions are monthly.
- Live prices: \`GET ${o}/api/v1/plans\` (public, no auth) or MCP \`plans_list\`.
- Browser link: \`${o}/pricing?plan=<plan_id>&months=<1|3|6|12>\`
- Connected: MCP \`billing_checkout_create\` ({ plan, months?, provider? "sepay" | "dodo" }) or \`POST ${o}/api/v1/billing/orders\` with the same JSON body. Status: MCP \`billing_order_get\` ({ code }) or \`GET ${o}/api/v1/billing/orders/{code}\`.
- Providers: \`sepay\` creates a VND bank-transfer order (\`ZSB…\`) with VietQR details; \`dodo\` starts a card subscription and returns \`checkout_url\`. Not every method is available at all times; if the provider is unconfigured the API returns an error. Report it, do not work around it.

## Courses

- Catalog and prices: ${o}/courses.md (detail pages: ${o}/courses/<slug>). Terms: ${o}/terms · Course policy and refunds: ${o}/policy
- Connected: MCP \`course_list\`, then \`course_checkout_create\` ({ course, provider?, accept_terms }) or \`POST ${o}/api/v1/courses/{course}/checkout\`. Status: MCP \`course_order_get\` ({ code }) or \`GET ${o}/api/v1/courses/orders/{code}\`.
- Send \`accept_terms: true\` **only after** the user has read the terms and policy above and affirmatively accepted them. Never accept for them.
- Paid lesson content is read in a signed-in browser. It is not available through MCP or the API.

## Consultation (1:1 booking)

- Start at ${o}/business. The user chooses an available session and slot, then pays (bank transfer, or PayPal where offered).
- Checkout requires a valid slot hold. There is no agent shortcut: do not claim you can create a booking payment without a slot the user picked.

## Connected agents: MCP and REST

- MCP endpoint: \`${o}/mcp\` (OAuth 2.1; the user approves scopes on a consent screen). The legacy \`${o}/api/mcp\` is an admin endpoint; do not use it for member purchases.
- REST: send \`Authorization: Bearer <key>\` and \`Content-Type: application/json\`. Never put keys or tokens in URLs, and never print them back to the user.
- Scopes: \`checkout:write\` creates orders, \`billing:read\` reads order status. You can only read orders owned by your user.

## Handoff to the human

Show these fields exactly as returned, never edited or rebuilt:

- \`checkout_url\` (card payments, when present)
- \`transfer.qr_url\`, \`transfer.amount\`, \`transfer.currency\`, \`transfer.transfer_content\` (bank transfer)
- \`status_url\` (the official order page)

If you cannot render images, give the user the \`qr_url\` and \`status_url\` links. Do not invent a QR code, bank account number, amount or transfer content. If \`transfer\` is null the order is not payable (expired or unconfigured); say so.

## Order status

| Status | What to tell the user |
| --- | --- |
| \`paid\` | Success, but only because the backend returned it. Not because the user said they paid. |
| \`pending\` | Waiting for payment. Re-check on request or at a calm interval, and stop when the order expires. |
| \`expired\` | The window closed. Ask whether to create a new order. Do not pay or reuse the old reference. |
| \`needs_attention\` | The payment needs a human review (for example a wrong amount). Point the user to support below; do not retry or create a duplicate order. |
| provider or API error | Report the error message as is. No blind retries, no switching provider without asking the user. |

## Security rules

- Do not collect card numbers, passwords, OTPs or bank credentials.
- Do not ask the user to send payment proof in chat as a substitute for backend confirmation.
- Do not change the payment reference, amount or currency.
- This guide is not permission to spend. Act only after the user's explicit confirmation for each purchase.
- Never auto-accept terms or policies.

## Terms and support

- Terms: ${o}/terms · Policy: ${o}/policy · Privacy: ${o}/privacy
- Support: hi@zuey.me
- Product, price and availability are always decided by the live backend, not by this page.
`;
}

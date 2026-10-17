# Agent checkout smoke checklist

Manual checks for `/checkout.md` (text in `src/lib/agent-commerce/checkout-markdown.ts`) and the flows it describes. Automated coverage: `tests/checkout-md.test.ts` (public route, discovery, secret-free content) plus `tests/billing.test.ts`, `tests/courses-commerce.test.ts` and `tests/oauth-mcp.test.ts` (scopes, ownership, order states).

1. **Public read.** `curl -si https://zuey.me/checkout.md` returns 200, `text/markdown`, no cookies, links on the same origin. It is listed in `/llms.txt`, `/llms-full.txt` and `/index.md`.
2. **Anonymous membership.** An agent with no tools gives `/pricing?plan=<id>&months=<n>`. The page opens with the plan preselected and the live price from `/api/v1/plans`.
3. **Authenticated membership (SePay).** With `checkout:write`, `billing_checkout_create` returns `transfer.qr_url`, `amount`, `currency`, `transfer_content`, `bank_account`, `bank_code` and `status_url`. The agent shows them unchanged.
4. **Authenticated course.** `course_checkout_create` without `accept_terms: true` is refused. With it, after the user accepted `/terms` and `/policy`, a course order (ZSC prefix) is returned.
5. **Status.** `billing_order_get` / `course_order_get` with `billing:read` shows `pending` before payment, `paid` after the webhook, `expired` after the window, `needs_attention` after a wrong amount. Another member's code is a 404.
6. **Card.** Where Dodo is configured, `provider: "dodo"` returns a `checkout_url` the user opens; status comes from `subscription_get` and succeeds at `active`.
7. **Unconfigured provider.** With the provider's env missing, creation fails with an error (503) and the agent reports it without retrying. An expired order shows `transfer: null`.
8. **Consultation.** `/business` is the only path; no booking payment exists without a slot hold.

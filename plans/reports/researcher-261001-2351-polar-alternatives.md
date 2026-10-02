# Thay thế Polar.sh cho zuey.me: cổng thanh toán quốc tế (USD/thẻ)

Ngày: 2026-10-01 (Asia/Saigon). Phạm vi: rail quốc tế cho người bán ở Việt Nam; SePay giữ nguyên cho VND.

## Kết luận

1. **Chọn Dodo Payments** cho 4 gói membership ($9 Knowledges, $9/tháng AI chat, $19/tháng combo, $29/tháng combo + Telegram). Dodo nhận người bán ở Việt Nam, là Merchant of Record (MoR), webhook theo chuẩn Standard Webhooks (cùng sơ đồ ký với Polar nên tái dùng được `verifyPolarSignature`), checkout session có `metadata`, và có sẵn entitlement Telegram.
2. **Phương án dự phòng là Paddle**, chỉ cho các gói AI chat và bài viết. Paddle cấm "community access" và tư vấn thuần túy, nên gói $29 phải được mô tả là phần mềm kèm quyền vào nhóm, nếu không thì bỏ gói này khỏi Paddle.
3. **Gói tư vấn B2B $1,999 không MoR nào nhận**: Dodo, Creem, Lemon Squeezy, Paddle, Stripe Managed Payments và Gumroad đều cấm hoặc hạn chế consulting/coaching. Khách VN trả qua SePay; khách quốc tế trả qua **PayPal Business (Orders API, không phải MoR)**. Nếu cần thẻ trực tiếp với chi phí thấp hơn về lâu dài thì dùng Stripe qua Atlas (US LLC).
4. **Không dùng cụm "AI Human Clone" trong hồ sơ hay trên site.** Đây gần như chắc chắn là thứ kích hoạt bộ lọc impersonation/deepfake/companion. Mô tả trung thực hơn và an toàn hơn là "trợ lý AI trả lời dựa trên nội dung Duy đã viết, được gắn nhãn rõ là AI".

## Bảng so sánh

Phí tính trên mỗi giao dịch $9 thẻ quốc tế dạng subscription, theo biểu phí công khai.

| Nhà cung cấp | Seller VN | MoR | Lập trường AUP (AI persona / consulting / community) | Sub + one-off | Webhook | Metadata | Phí ~$9 | Payout VN | Workers fetch |
|---|---|---|---|---|---|---|---|---|---|
| **Dodo Payments** | Có (#173 trong danh sách) | Có | Chatbot nằm diện "restricted" (cấm voice cloning, cấm impersonation); cấm "AI relationship companions"; **cấm coaching/consulting**; community được phép nếu khớp sản phẩm đã khai | Có | Standard Webhooks | Có, trên checkout session | 4%+1.5%+0.5%+$0.40 ≈ $0.94 | Ngân hàng nội địa / SWIFT ($25) / Payoneer | Có (REST) |
| **Paddle** | Có (không nằm trong danh sách unsupported) | Có | Cấm "likeness without consent", face/voice gen; **cấm consulting, coaching, "community of experts", community access** | Có | `Paddle-Signature` HMAC | `custom_data` | 5%+$0.50 ≈ $0.95 (dưới $10 thì "liên hệ") | Có | Có |
| Lemon Squeezy | Có (bank payout qua Stripe, hoặc PayPal) | Có | Chỉ cấm NSFW chatbot; **cấm "services of any kind" kể cả consulting** | Có | HMAC `X-Signature` | `custom` | 5%+$0.50 + phụ phí | Có | Có |
| Creem | Có | Có | **Cấm "AI companion or relationship chatbots of any kind"**; services/consulting thuộc diện restricted, đòi lịch sử xử lý thanh toán | Có | HMAC `creem-signature` | Có | 3.9%+$0.40 ≈ $0.75 | Ngân hàng (7 USD hoặc 1%) | Có |
| Stripe trực tiếp | **Không**; chỉ đi được qua Atlas (US LLC) | Không | AUP thoáng hơn, nhận được consulting | Có | Có | Có | ~2.9%+$0.30 (US) | Về ngân hàng Mỹ của LLC | Có |
| Stripe Managed Payments | **Không** (VN không có trong danh sách nước hỗ trợ) | Có | Cấm consulting và dịch vụ có người làm 1-1 | Có | Có | Có | 6.4%+$0.30 (theo bên thứ ba) | — | — |
| PayPal Business | Có ("Send, receive, withdraw") | Không | Nhận dịch vụ, nhưng seller protection không áp dụng cho hàng vô hình | Có (Subscriptions API; chưa xác minh riêng cho tài khoản VN) | Tự verify bằng CRC32 + cert, hoặc gọi API postback | `custom_id` | 4.4%+$0.30 ≈ $0.70, cộng FX | Rút về ngân hàng VN mất 60.000đ | Có (dùng postback) |
| Gumroad | — | Có | **Cấm "AI services… chatbots… subscriptions to AI services"** | — | — | — | — | — | Loại |
| FastSpring | Không có danh sách cấm VN | Có | Không thấy cấm AI hay consulting; bán qua sales, giá đàm phán | Có | HMAC | Có | Đàm phán | Có | Có |
| 2Checkout/Verifone | Có (VN không bị hạn chế) | Có (2Monetize) | Cần hồ sơ công ty; danh sách cấm không công khai rõ | Có | IPN HMAC (kiểu cũ) | `order-ext-ref` | Không xác minh được | Có | Có, nhưng API nặng |
| Payoneer Checkout | **Không**: chỉ cho pháp nhân HK hoặc từ $20k/tháng | Không | — | — | — | — | — | — | Loại |

## Vì sao chọn Dodo

- **Thật sự nhận người bán ở Việt Nam.** Vietnam có trong [accepted countries](https://docs.dodopayments.com/miscellaneous/accepted-countries-and-territories). Lemon Squeezy cũng nhận VN nhưng đang đi vào giai đoạn khai tử, xem phần rủi ro bên dưới.
- **AUP khớp với sản phẩm khi mô tả đúng.** Theo [Merchant Acceptance](https://docs.dodopayments.com/miscellaneous/merchant-acceptance), "SaaS & AI products" được nhận. "Audio/music/chatbot generators" nằm diện restricted với điều kiện "No voice cloning, NSFW, IP Infringements or fake claims", còn "AI Content Generation tools" thì "No impersonation". Một AI persona do chính người sáng tạo sở hữu, đồng ý và gắn nhãn AI không phải là impersonation người khác. Tuy vậy Dodo vẫn sẽ hỏi thêm: disclaimer, demo account, link policy.
- **Kiến trúc gần như không phải đổi.** Dodo dùng Standard Webhooks (ký `id.timestamp.body` với các header `webhook-id`, `webhook-timestamp`, `webhook-signature`), cùng chuẩn mà `src/lib/payments/polar.ts` đang verify bằng `crypto.subtle`. Checkout session nhận `metadata` để truyền `booking_id`/`user_id`. Lưu ý: `GET /checkouts/{id}` không trả `metadata`, phải đọc từ payment hoặc từ payload webhook. Có [Telegram entitlement](https://docs.dodopayments.com/changelog/v1.97.6.md) phục vụ gói $29. Toàn bộ là REST qua fetch, không cần SDK Node.
- **Phí và payout.** [Pricing](https://dodopayments.com/pricing): 4%+40¢, cộng 1.5% cho thẻ ngoài Mỹ, cộng 0.5% cho subscription. Payout dưới $1,000 tốn $5, SWIFT USD tốn $25. Payoneer được coi như một tài khoản ngân hàng, tức là phí nhận nội địa sẽ thấp hơn SWIFT.
- **Điểm yếu.** Dodo cấm "Manual Digital Services… coaching, freelancing or consulting", nên **tuyệt đối không bán gói $1,999 qua Dodo**. Nếu trang /booking hiện giá $1,999, cần ghi chú rõ với Dodo rằng khoản này thanh toán ngoài Dodo. Phí thực tế khoảng 10% trên gói $9, cao hơn Creem.

## Rủi ro áp dụng

| Nhà cung cấp | Độ trưởng thành | Rủi ro chính |
|---|---|---|
| Dodo | Startup (từ 2024), ra bản cập nhật hằng tuần ([changelog](https://docs.dodopayments.com/llms.txt) tới v1.113, 09/2026) | Review AUP mang tính chủ quan ("if it feels shady…"). Cộng đồng nhỏ hơn Paddle. Có thể bị hỏi về lần từ chối của Polar. |
| Paddle | Lâu đời, quy mô lớn | Review khắt khe với "human services/community". Gói giá dưới $10 bị đẩy sang giá tùy chỉnh. |
| Lemon Squeezy | Thuộc Stripe | **Nguy cơ bị bỏ rơi cao.** [Blog 01/2026](https://www.lemonsqueezy.com/blog/2026-update) xác nhận hướng di chuyển sang Stripe Managed Payments, mà Managed Payments [không hỗ trợ VN](https://docs.stripe.com/payments/managed-payments/eligibility.md). Người bán VN có thể rơi vào thế phải lập Atlas. |
| Creem | Startup | Câu cấm "AI companion… chatbots of any kind" có thể bị reviewer đọc theo nghĩa rộng ([account reviews](https://docs.creem.io/merchant-of-record/account-reviews/account-reviews)). Nếu bị reject thì không được xin review lại. |
| PayPal | Rất lâu đời | Hay giữ tiền (hold) và mở tranh chấp ở giao dịch giá trị cao. Tài khoản VN có phí FX và trần giao dịch. |
| Stripe Atlas | Ổn định | Tốn $500 lập công ty, phí agent hằng năm, nghĩa vụ IRS Form 5472/1120 (phạt nặng nếu bỏ sót), phải có ngân hàng Mỹ. Không phải MoR, nên tự lo VAT/GST cho khách. |

## Đề xuất triển khai (chỉ ở mức kiến trúc)

- Định tuyến theo sản phẩm: membership → Dodo; consultation → SePay (VND) hoặc PayPal Orders (USD, `custom_id=booking_id`).
- Viết adapter `dodo.ts` cùng shape với `polar.ts` (tạo checkout, verify, parse) để tái dùng verifier Standard Webhooks (DRY). Nếu chọn Paddle thì viết thêm verifier HMAC `ts;h1`.
- Với PayPal trên Workers: verify webhook bằng postback `POST /v1/notifications/verify-webhook-signature` qua fetch, vì cách tự verify bằng cert X.509 và CRC32 khó làm với `crypto.subtle` ([PayPal webhooks](https://developer.paypal.com/api/rest/webhooks/rest/)).

## Cách mô tả sản phẩm trung thực với nhà cung cấp

Nguyên tắc: không giấu tính năng, không dùng chữ dễ hiểu sai. Mọi tuyên bố trong mô tả phải khớp với nội dung site.

Mẫu (tiếng Anh, dùng cho form onboarding):

> zuey.me is the membership site of Duy Nguyen, a Vietnam-based creator. Members pay for: (1) "Knowledges", a library of Duy's written articles; (2) an AI assistant that answers questions using only Duy's own published writing, built and operated by Duy himself with his explicit consent, and clearly labelled in the UI as AI, not a human; (3) a higher tier that adds access to a private Telegram group for members. Text chat only: no voice cloning, no face/video generation, no third-party likeness, no romantic/companion or NSFW use. Fulfilment is fully automated via our web app. Separately, Duy offers B2B consulting engagements, which are invoiced outside [provider] via bank transfer/PayPal and are not sold through your checkout. Polar.sh previously declined our application; [nêu lý do nếu Polar có cho biết].

Những việc cần làm trên site trước khi nộp hồ sơ:

- Đổi "AI Human Clone" thành "Duy's AI assistant" hoặc "Ask Duy (AI)".
- Có nhãn "AI-generated, may be inaccurate" trong khung chat.
- Có trang Terms, Privacy và Refund, email hỗ trợ trùng với email đăng ký, bảng giá hiển thị rõ.
- Có tài khoản demo cho reviewer.
- Không hứa hẹn kết quả kiểu "make money".

Nên chủ động khai lần bị Polar từ chối. Che giấu chuyện này mà bị phát hiện thì đó là lý do chấm dứt tài khoản theo mục "Failing to disclose" trong AUP của Dodo.

## Giới hạn của nghiên cứu

- Không liên hệ trực tiếp bộ phận compliance của nhà cung cấp nào. Việc AUP có chấp nhận hay không là suy luận từ văn bản chính sách, mà review thực tế mang tính chủ quan.
- Chưa xác minh: hình thức payout cụ thể của Dodo về ngân hàng VN (nội địa hay SWIFT); PayPal Subscriptions và trần giao dịch cho tài khoản Business VN; phí và danh sách cấm của 2Checkout và FastSpring (cả hai đều báo giá theo đàm phán). Con số 6.4%+30¢ của Stripe Managed Payments lấy từ nguồn bên thứ ba ([paritydeals](https://www.paritydeals.com/stripe-managed-payments-vs-lemon-squeezy-fees/)).
- Không phân tích nghĩa vụ thuế thu nhập tại VN của người bán, vì MoR chỉ xử lý thuế gián thu (VAT/GST) phía người mua.

## Nguồn

- Dodo: [merchant-acceptance](https://docs.dodopayments.com/miscellaneous/merchant-acceptance), [accepted countries](https://docs.dodopayments.com/miscellaneous/accepted-countries-and-territories), [pricing](https://dodopayments.com/pricing), [llms-full.txt](https://docs.dodopayments.com/llms-full.txt) (webhooks, metadata, payouts)
- Paddle: [AUP](https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle), [countries](https://www.paddle.com/help/start/intro-to-paddle/which-countries-are-supported-by-paddle), [pricing](https://www.paddle.com/pricing)
- Creem: [llms-full.txt](https://docs.creem.io/llms-full.txt) (account reviews, supported countries, fees)
- Lemon Squeezy: [prohibited](https://docs.lemonsqueezy.com/help/getting-started/prohibited-products), [supported countries](https://docs.lemonsqueezy.com/help/getting-started/supported-countries), [2026 update](https://www.lemonsqueezy.com/blog/2026-update)
- Stripe: [global](https://stripe.com/global), [Managed Payments eligibility](https://docs.stripe.com/payments/managed-payments/eligibility.md), [Atlas terms](https://stripe.com/legal/atlas)
- PayPal: [VN fees](https://www.paypal.com/vn/webapps/mpp/merchant-fees), [country features](https://developer.paypal.com/payouts/supported-features), [webhooks](https://developer.paypal.com/api/rest/webhooks/rest/)
- Gumroad: [prohibited (rev. 2026-09-16)](https://gumroad.com/prohibited). 2Checkout: [llms-full.txt](https://docs.2checkout.com/llms-full.txt). FastSpring: [pricing](https://fastspring.com/pricing/). Payoneer: [Checkout FAQ](https://payoneer.custhelp.com/app/answers/detail/a_id/40689/~/payoneer-checkout---faq)

## Câu hỏi còn mở

1. Polar có nêu lý do từ chối cụ thể không? Nếu lý do là "human services/consulting" chứ không phải AI persona, thì Paddle nên được xếp hạng cao hơn.
2. Có chấp nhận bỏ gói $29 (Telegram) khỏi rail MoR nếu reviewer của Paddle/Dodo phản đối không?
3. Khách $1,999 quốc tế có chịu trả qua PayPal hoặc chuyển khoản SWIFT/Wise không, hay bắt buộc phải có thẻ? Nếu bắt buộc thẻ thì cần cân nhắc Stripe Atlas.

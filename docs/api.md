# API quick reference

Swagger UI is at `/docs` and its OpenAPI JSON is at `/docs-json`. All business routes use `/v1`. Money values are integer PKR minor units (paisa). Private calls use `Authorization: Bearer <accessToken>`; registration and login return an access token and set an HttpOnly refresh cookie.

The OpenAPI document defines the JSON response shape for every operation, including nested cart/order lines, pagination cursors, nullable dates, payment and fulfillment enums, and the common error body. Auth responses list only safe user fields and the access token; the refresh token is a cookie and is absent from JSON. Public catalog schemas omit SKU and stock counts. `GET /v1/cart` and cart edits return the current version in both `version` and `ETag`. A `204` logout has no body.

| Method and path | Purpose |
| --- | --- |
| `POST /v1/auth/register` | Create an active account from `{ name, email, phone, password }`; phone uses E.164 format. |
| `POST /v1/auth/login` | Password login from `{ identifier, password }`, where identifier is email or phone. |
| `POST /v1/auth/otp/request` | Start passwordless login from `{ identifier, channel: "email" | "phone" }`; code expires in five minutes. |
| `POST /v1/auth/otp/verify` | Exchange `{ challengeId, code }` for an access token and refresh cookie. |
| `POST /v1/auth/refresh`, `POST /v1/auth/logout` | Rotate or revoke the refresh session. |
| `GET /v1/me` | Return the current user. |
| `GET /v1/products`, `GET /v1/products/:id` | Public product catalog and size/type variants. List supports cursor and limit. Public responses contain product ID, name, description, and variants with ID, name, price, currency, and an availability flag; SKU, exact stock, and archive metadata are admin-only. |
| `GET /v1/config/checkout` | Public PKR currency, configured bank-transfer instructions, and whether local demo payment is enabled. |
| `GET /v1/cart` | Current user's cart, items, total and numeric version. |
| `PUT /v1/cart/items/:variantId`, `DELETE /v1/cart/items/:variantId` | Set `{ quantity }` or remove one variant. Send `If-Match` with the cart version; read the returned version before the next edit. |
| `POST /v1/orders` | Place the cart as an order. Send a UUID `Idempotency-Key`, current cart `If-Match`, and `{ paymentType: "cod" | "bank_transfer" | "demo", expectedTotalMinor }`. `demo` is accepted only when `DEMO_PAYMENTS_ENABLED=true` outside production. |
| `GET /v1/orders`, `GET /v1/orders/:id`, `GET /v1/orders/:id/status` | Current user's order history, immutable detail, and current payment/fulfillment state. |
| `PUT /v1/orders/:id/transfer-reference` | Submit `{ reference }` for a pending bank transfer. |
| `GET/POST /v1/admin/products`, `GET/PATCH/DELETE /v1/admin/products/:id` | Admin catalog list/create/read/update/archive. Archive preserves historical order lines. |
| `POST /v1/admin/products/:id/variants`, `PATCH/DELETE /v1/admin/variants/:id`, `POST /v1/admin/variants/:id/stock-adjustments` | Admin variant and audited stock operations. |
| `GET /v1/admin/orders`, `POST /v1/admin/orders/:id/mark-paid`, `POST /v1/admin/orders/:id/cancel` | Admin order review, payment recording after fulfillment is ready, and audited cancellation/restock. |

Checkout returns a unique order ID with `status: "pending"`, `paymentStatus: "pending"`, and `fulfillmentStatus: "queued"`. The order, stock change, fulfillment task, outbox event, and one pending simulated payment record for `demo` commit before the response. A separate RabbitMQ worker validates the committed item snapshot and moves fulfillment to `ready`; bounded retry exhaustion moves it to `failed`. For `demo` only, the successful worker transaction also marks the simulated payment succeeded and order paid. This is a local simulation with no real charge. COD and bank transfer remain pending until an admin records verified payment after fulfillment is ready. Cancellation moves order and fulfillment to `cancelled` and cancels a pending demo payment; failed fulfillment retains stock and pending payment until admin cancellation/restock. A same-key checkout retry returns the first order; using the key for a different cart or payment request is a conflict.

Validation, version conflicts, unavailable stock, auth failures and rate limits return a JSON error with `code`, `message`, and `requestId`. A rate-limit response includes `Retry-After` in seconds. Cart and checkout version conflicts should refresh the cart before retrying. Public clients never set product price, authoritative total, stock, role, or paid state.

Order endpoints have PostgreSQL-backed limits per authenticated account across API replicas: by default 120 order reads per minute, 12 new checkout attempts per hour, 12 customer transfer-reference changes per hour, and 60 admin payment/cancellation changes per minute. A completed checkout remains readable through an identical `Idempotency-Key` even after the new-attempt limit is reached; those replays use the order-read quota. Limits are configurable in `.env`; existing IP and identity limits for authentication remain separate.

For a checkout `503` caused by admission or a transient PostgreSQL failure, wait for `Retry-After` and retry the **same** body, `Idempotency-Key`, and `If-Match`. The commit may have succeeded before the connection failed; changing the key could create a second order. A `409` price/stock conflict requires reviewing the cart and starting a new checkout attempt. Server error logs contain the request ID and safe error class/code, never SQL text, credentials, tokens, or customer details. Malformed notification events go directly to the dead-letter queue because retrying identical bytes cannot repair them; provider/database failures receive bounded delayed retries. Fulfillment has its own queue and failure state.

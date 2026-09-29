# Food Order Assessment

An end-to-end food ordering assessment with a Next.js storefront, a NestJS API, PostgreSQL transactions, Redis catalog caching, and RabbitMQ workers. It covers customer and admin flows from signup through checkout, fulfillment, and order history. Demo payment is a clearly labeled local simulation; it does not charge money.

This README is the setup and submission guide. The [API reference](docs/api.md) describes routes and errors, the [API setup notes](apps/api/README.md) explain the server layout, the [frontend design guide](apps/web/DESIGN.md) covers the UI, and the [deployment runbook](deploy/README.md) covers operations.

## Run locally with Docker

You need Docker with Compose and free host ports **3000**, **3001**, **5433**, **6380**, **5672**, **15672**, and **8025**. From the repository root, create your local environment file:

```sh
cp .env.example .env
```

Edit `.env` and replace `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `OTP_PEPPER`, `AUTH_TOKEN_HASH_SECRET`, and `OTP_ENCRYPTION_KEY` with **five independent random values**. Generate each of the first four with `openssl rand -hex 32`; generate the encryption key with `openssl rand -base64 32`. The template's PostgreSQL and RabbitMQ credentials are for local development. `.env` is ignored by Git. Local Compose binds service ports to loopback; its Redis service has no password, so `REDIS_PASSWORD` in the template applies to the production recipe, not this local Redis container.

Then start the stack and add the sample menu:

```sh
docker compose up --build -d
docker compose exec api node scripts/seed-demo.mjs
```

Open [the storefront](http://localhost:3000), [API readiness](http://localhost:3001/v1/health/ready), and [Swagger UI](http://localhost:3001/docs). The one-shot migration runs before the API. If startup is still in progress, inspect `docker compose ps` and `docker compose logs api worker web`; retry the readiness URL when the services are healthy. [Mailpit](http://localhost:8025) shows local email OTPs and order notices. The [RabbitMQ management UI](http://localhost:15672) shows local queues. The seed adds eight synthetic products and can be run again without erasing existing data.

### Try a complete order

1. In the storefront, create an account, add a product variant to the cart, and open checkout.
2. Choose **Demo payment** to see the local automated flow. The order starts pending/queued, then the worker marks fulfillment ready and the simulated payment paid. No money is charged. Cash on delivery and bank transfer stay pending until an admin records payment.
3. Open **Orders** to see the result. For email OTP login, request a code and read it in Mailpit. Phone OTP requires Twilio credentials.
4. To use the admin screen, run `docker compose exec api node scripts/promote-admin.mjs user@example.com --confirm` with your registered email, then refresh the app or sign in again so the displayed role updates. The API reads the current database role for every protected request, so the promotion takes effect server-side immediately.

Stop the stack with `docker compose down`. This preserves database volumes and your local accounts/orders. `docker compose down -v` deletes those volumes and all local data; use it only when you intend to reset the environment.

Local Compose enables `demo` only for the assessment; production rejects it. For bank-transfer instructions, set `BANK_NAME`, `BANK_ACCOUNT_NAME`, and `BANK_IBAN`. Production email/SMS delivery needs real SMTP/Twilio settings and recipient tests. `OTP_DELIVERY_MODE=test` works only under `NODE_ENV=test` and must never be used publicly.

The browser app has direct menu (`/`), cart (`/cart`), orders (`/orders`), account (`/account`), and admin (`/admin`) routes. Its [design system](apps/web/DESIGN.md) records the responsive layout and feedback states. The menu names, prices, and food images are synthetic assessment data. The server calculates account role, cart totals, stock, checkout, and payment state.

## Development outside Docker

Use Node.js 22.22.3 or newer.

Start `postgres`, `redis`, and `rabbitmq` with `docker compose up -d postgres redis rabbitmq`. Run `npm ci`, `npm run db:migrate`, `npm run dev:api`, and `npm run dev:web` in separate terminals. The API reads the root `.env` and connects to PostgreSQL on host port `POSTGRES_PORT` (default `5433`). For a native worker, set `RABBITMQ_URL` to the host-published address (`127.0.0.1:5672`, not Docker's `rabbitmq` hostname), then run `npm run build --workspace=api` and `npm run start:worker --workspace=api`. The [API setup notes](apps/api/README.md) list the host connection values. Docker Compose sets container hostnames automatically.

The API uses `/v1` routes for registration, password and OTP login, catalog, cart, checkout, order history, and admin product/order operations. Swagger and the [API quick reference](docs/api.md) describe the contract. Order prices and totals are calculated from PostgreSQL at checkout; a repeated `Idempotency-Key` returns the original order instead of creating another. The first release defaults to 100 distinct cart lines, 32 in-flight checkouts per API instance, and a 10-connection PostgreSQL pool **per API or worker process**. Authenticated order requests have account-level limits shared across API replicas; the defaults and `.env` settings are in the [API guide](docs/api.md). Budget the sum of database pools below the PostgreSQL server limit with room for migrations and operations; tune the bounded `.env` settings against measured load.

## Checks and tests

Run `npm run lint`, `npm run typecheck`, and `npm test` for focused local checks. `npm run test:e2e` requires a disposable PostgreSQL database whose name contains `test`; set `TEST_DATABASE_URL` to its URL. Set `TEST_RABBITMQ_URL` to a local RabbitMQ vhost whose name contains `test` to include the real broker round trip. The suite touches only that test vhost's order queues. Required test suites fail if they contain no tests.

For the default local Compose credentials, create the isolated test resources once with `docker compose exec -T postgres createdb -U food_ordering food_ordering_test`, `docker compose exec -T rabbitmq rabbitmqctl add_vhost food_ordering_test`, and `docker compose exec -T rabbitmq sh -c 'rabbitmqctl set_permissions -p food_ordering_test "$RABBITMQ_DEFAULT_USER" ".*" ".*" ".*"'`. Then use `TEST_DATABASE_URL=postgresql://food_ordering:food_ordering_dev@127.0.0.1:5433/food_ordering_test` and `TEST_RABBITMQ_URL=amqp://food_ordering:food_ordering_dev@127.0.0.1:5672/food_ordering_test` for the E2E command. If you changed the development passwords in `.env`, use those values in the test URLs.

`npm run test:browser` runs desktop and mobile Chromium customer, admin, session, and checkout journeys against dedicated API and web dev servers. Stop any API/web containers or processes using ports 3001/3000 first. Create an isolated database named with the `_test` suffix, then set `BROWSER_TEST_DATABASE_URL` (or `TEST_DATABASE_URL`) to that database. The test runner applies migrations and inserts synthetic catalog and account data. Install the browser once with `npx playwright install chromium`. The CI workflow provisions disposable PostgreSQL, Redis, and RabbitMQ services, scans Git history for secrets, runs the checks and browser tests, and builds both Docker images.

## Publishing and operations

**Public signup is not ready for release.** Direct registration activates the supplied email and phone without proving ownership, as required by the selected assessment behavior. Another person could register your contact first, then an OTP sent to you would sign you into that person's account. Add contact ownership verification and a migration for existing accounts before accepting public users. Also set an operational policy for unpaid orders that reserve stock; the current assessment flow releases stock when an admin cancels an order.

Tagging a verified commit with `v*` publishes versioned API and web images to GHCR. Deployment is manual: configure the host, DNS, provider credentials, bank instructions, off-host backup destination, and the image tags in `.env`, then follow [the production runbook](deploy/README.md). The production Compose file places PostgreSQL, Redis, and RabbitMQ on a private Docker network and exposes only Caddy on ports 80/443. Caddy obtains TLS certificates for `APP_DOMAIN`.

## Implementation and design decisions

| Area | What is implemented and why |
| --- | --- |
| Authentication | Passwords use bcrypt. Email and phone OTP are five-minute, one-use login challenges with bounded guesses. PostgreSQL stores keyed token and code hashes; the worker receives an encrypted OTP payload after the challenge commits. Access JWTs are short-lived, refresh cookies rotate, and protected requests check the current database session, user status, and role. |
| Cart and checkout | The server owns prices, totals, stock, and payment state. Cart versions use If-Match. Checkout requires an idempotency key and commits the order, item snapshots, stock deduction, fulfillment task, and outbox event in one PostgreSQL transaction. A repeated request with the same key returns its original order. |
| Background work | RabbitMQ workers process fulfillment and notices after checkout. The outbox retains committed work during a broker outage; consumers deduplicate retries. Redis caches only public catalog reads, so cache failure cannot change orders or stock. |
| Payments | Cash on delivery and bank transfer remain pending until an admin records verified payment. Demo payment is enabled only outside production and is marked paid by the successful fulfillment worker; it never contacts a payment provider. |
| Frontend | The Next.js menu, cart, account, orders, and admin routes call the documented API. The browser keeps its access token in memory, restores sessions through the refresh cookie, preserves the checkout key for lost-response retries, and displays separate payment and fulfillment states. Server guards enforce ownership and admin access. |
| Capacity controls | The default PostgreSQL pool has 10 connections per API or worker process, with a five-second acquisition timeout. Each API process admits at most 32 simultaneous checkouts. PostgreSQL-backed per-account limits span API replicas: 120 order reads per minute, 12 checkout attempts per hour, 12 transfer-reference changes per hour, and 60 admin order changes per minute. Budget the sum of process pools below the database connection limit. |

## Failures and retries

| Event | Expected behavior |
| --- | --- |
| Stale cart, changed price, or unavailable stock | Checkout rolls back. Refresh the cart, review the total, and start a new attempt. |
| Lost checkout response or temporary 503 | The order may already exist. Wait for Retry-After, then retry the same body, idempotency key, and If-Match value. |
| Account rate limit | A 429 includes Retry-After. Wait before trying again; an identical completed checkout uses the read quota. |
| Broker or worker outage | The order stays committed and queued. The outbox and bounded worker retries resume processing; an exhausted task needs inspection and recovery. |
| Redis outage | Public catalog reads fall back to PostgreSQL. Checkout uses database truth. |
| Cancelled order | Audited cancellation restores stock once and prevents a late worker retry from completing or paying the order. |

## Verification and release boundary

The [GitHub Actions workflow](.github/workflows/verify-and-publish.yml) scans Git history for secrets, checks Compose files, runs lint, TypeScript, unit, API end-to-end, and desktop/mobile browser tests, and builds the API and web images. Judge a submission by the run for its exact commit. API tests use disposable PostgreSQL and RabbitMQ test resources; browser tests cover customer, admin, session, and checkout journeys. The [bounded local load notes](docs/load-results.md) are a small diagnostic ramp, not proof of the PDF's five-million-parallel-orders target.

This is an assessment implementation, not a verified public deployment. Before public signup, prove contact ownership and migrate existing accounts. Before public unpaid checkout, define reservation limits and expiry for stock held by cash or bank orders. Before production email, enforce SMTP TLS and test delivery. Verify exclusive account control and revoke old credentials before admin promotion. Review sibling-subdomain cookie isolation, real domain and TLS, backup restore, provider delivery, and representative load on the intended infrastructure. The current source and automated checks cannot prove live provider behavior or production capacity.

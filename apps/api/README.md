# Food Ordering API

NestJS and TypeScript implementation of the supplied Food Ordering System PDF. The API workspace remains under `apps/api` while its `src` directory mirrors the PDF's suggested layout:

| Directory | Responsibility |
| --- | --- |
| `controllers/` | HTTP endpoints and request/response contracts |
| `models/` | DTOs and domain types |
| `routes/` | NestJS modules and wiring |
| `middlewares/` | JWT/role guards and error handling |
| `services/` | Authentication, catalog, cart, orders, cache, and queue work |
| `utils/` | Shared security and ownership helpers |
| `config/` | Environment validation and PostgreSQL connection |

`src/main.ts` is the NestJS entrypoint equivalent of the PDF's suggested `app.js`; `src/worker.ts` starts the RabbitMQ worker separately.

## Setup

From the repository root, copy `.env.example` to `.env` and replace the auth secret placeholders. Start PostgreSQL, Redis, and RabbitMQ with `docker compose up -d postgres redis rabbitmq`, then run `npm ci` and `npm run db:migrate`. The migration runner applies `apps/api/migrations/*.sql` in order and records completed files in `schema_migrations`; TypeORM synchronization remains disabled.

Run `npm run dev:api` from the root. The API uses the root `.env`; for a native process connecting to the Docker data services, use `DB_HOST=127.0.0.1`, `DB_PORT=5433`, `REDIS_URL=redis://127.0.0.1:6380`, and `RABBITMQ_URL=amqp://food_ordering:food_ordering_dev@127.0.0.1:5672` (adjust credentials and published ports to match your `.env`). After `npm run build --workspace=api`, start the native worker with `npm run start:worker --workspace=api` using that host-accessible `RABBITMQ_URL`. The complete Docker Compose stack sets container hostnames automatically.

Swagger UI is at `http://localhost:3001/docs`, the OpenAPI JSON is at `/docs-json`, and readiness is at `/v1/health/ready`. The `/v1` API includes auth, products, cart, checkout, order history, and admin routes. The JWT guard protects private endpoints; a customer cannot grant their own admin role.

To create a catalog in a disposable local database, run `npm run seed:demo --workspace=api`. Register a user normally, then grant that existing account admin access with `npm run admin:promote --workspace=api -- user@example.com --confirm`. Sign in again for an updated session. Demo seeding is disabled in production; verify the target account before promotion and run the command under an accountable operator change record. The database promotion event identifies the target account, so the change record must identify the human operator.

## Tests

Run `npm run lint --workspace=api`, `npm run typecheck --workspace=api`, and `npm test --workspace=api`. For integration and HTTP end-to-end checks, set `TEST_DATABASE_URL` to a disposable PostgreSQL database whose name contains `test`; set `TEST_RABBITMQ_URL` to a local RabbitMQ vhost whose name contains `test` to run broker checks; then run `npm run test:e2e --workspace=api`. Tests use isolated schemas or temporary sibling databases and require the test database role to create databases. See the root README for browser testing and release instructions.

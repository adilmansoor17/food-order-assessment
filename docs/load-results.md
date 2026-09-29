# Bounded local checkout ramp

The script sends real HTTP `POST /v1/orders` requests to a temporary NestJS server backed by a disposable PostgreSQL database. It prepares one user, session, and cart per planned order. The database name supplied through `LOAD_TEST_DATABASE_URL` must contain `test` and the server must be local; the script creates and drops its own temporary database. It defaults to 100 orders and 20 client workers and caps input at 1,000 orders and 100 workers.

Use Node 24, build the API once, and start local PostgreSQL. Create `food_ordering_test` if absent. These commands reproduce the two small scenarios:

```sh
nvm use 24
test -f .env || cp .env.example .env
docker compose up -d postgres
docker compose exec -T postgres createdb -U food_ordering food_ordering_test
npm run build --workspace=api
LOAD_TEST_DATABASE_URL=postgresql://food_ordering:food_ordering_dev@127.0.0.1:5433/food_ordering_test LOAD_ORDERS=20 LOAD_CONCURRENCY=5 LOAD_REPLAY_EVERY=5 npm run load:orders
LOAD_TEST_DATABASE_URL=postgresql://food_ordering:food_ordering_dev@127.0.0.1:5433/food_ordering_test LOAD_ORDERS=20 LOAD_CONCURRENCY=5 LOAD_VARIANT_MODE=hot npm run load:orders
```

`createdb` is a one-time step; skip it when the test database already exists. `LOAD_VARIANT_MODE=distributed` is the default. `LOAD_REPLAY_EVERY=5` repeats each fifth successful checkout with its original idempotency key and checks that it returns the same order ID.

| Local run, 2026-09-29 | Committed | Replays | Conflicts / errors | p50 | p95 | Committed/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Distributed variants, 20 orders / 5 workers | 20 | 4 | 0 / 0 | 11.97 ms | 48.46 ms | 213.40 |
| One hot variant, 20 orders / 5 workers | 20 | 0 | 0 / 0 | 15.22 ms | 55.78 ms | 168.60 |

These runs use migration 002 and include the synchronous fulfillment-task and outbox writes at checkout. Each timed portion lasted about 0.1 seconds on one local machine. Setup, migration, worker delivery, network hops, and sustained traffic are outside the timed interval. These figures are a smoke-level comparison, not a throughput limit, release SLO, or evidence for five million parallel orders. A production-shaped burst and sustained ramp still need offered/admitted request counts, p99 latency, queue age/drain, database lock/WAL/IO, and generator-saturation measurements.

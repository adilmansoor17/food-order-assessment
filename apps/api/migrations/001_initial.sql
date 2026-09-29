CREATE TABLE users (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  email text NOT NULL UNIQUE CHECK (email = lower(btrim(email))),
  phone_e164 text NOT NULL UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  family_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE otp_challenges (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email', 'phone')),
  purpose text NOT NULL CHECK (purpose = 'login'),
  code_hash text NOT NULL,
  delivery_ciphertext text,
  delivery_nonce text,
  delivery_tag text,
  attempts_remaining smallint NOT NULL DEFAULT 5 CHECK (attempts_remaining BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at <= created_at + interval '5 minutes')
);
CREATE UNIQUE INDEX otp_open_challenge_idx ON otp_challenges (user_id, channel, purpose)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;
CREATE INDEX otp_expiry_idx ON otp_challenges (expires_at);

CREATE TABLE auth_rate_counters (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (key, window_start)
);
CREATE INDEX auth_rate_counters_expiry_idx ON auth_rate_counters (window_start);

CREATE TABLE products (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_active_idx ON products (created_at DESC, id DESC) WHERE active AND archived_at IS NULL;

CREATE TABLE variants (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  sku text NOT NULL UNIQUE,
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  stock integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX variants_product_idx ON variants (product_id, id) WHERE active;

CREATE TABLE carts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cart_items (
  cart_id uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES variants(id),
  quantity smallint NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  PRIMARY KEY (cart_id, variant_id)
);

CREATE TABLE orders (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled')),
  payment_type text NOT NULL CHECK (payment_type IN ('cod', 'bank_transfer')),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  transfer_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  cancelled_at timestamptz
);
CREATE INDEX orders_user_recent_idx ON orders (user_id, created_at DESC, id DESC);

CREATE TABLE order_items (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  product_id uuid NOT NULL REFERENCES products(id),
  variant_id uuid NOT NULL REFERENCES variants(id),
  product_name text NOT NULL,
  variant_name text NOT NULL,
  quantity smallint NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor bigint NOT NULL CHECK (line_total_minor >= 0)
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

CREATE TABLE checkout_requests (
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  order_id uuid NOT NULL REFERENCES orders(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idempotency_key)
);
CREATE INDEX checkout_requests_created_idx ON checkout_requests (created_at);

CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox (available_at, created_at, id) WHERE status = 'pending';

CREATE TABLE consumer_dedupe (
  event_id uuid NOT NULL,
  consumer text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, consumer)
);

CREATE TABLE admin_audit (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL,
  target_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_target_idx ON admin_audit (target_id, created_at DESC);

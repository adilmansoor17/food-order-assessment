ALTER TABLE orders DROP CONSTRAINT orders_payment_type_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_type_check
  CHECK (payment_type IN ('cod', 'bank_transfer', 'demo'));

-- A demo payment is a local simulation, never evidence of an external charge.
-- One row per demo order lets checkout create the attempt and the worker settle it
-- atomically with fulfillment. Existing COD and bank-transfer orders are unchanged.
CREATE TABLE simulated_payments (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL DEFAULT 'PKR' CHECK (currency = 'PKR'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  cancelled_at timestamptz,
  CONSTRAINT simulated_payments_state_check CHECK (
    (status = 'pending' AND settled_at IS NULL AND cancelled_at IS NULL) OR
    (status = 'succeeded' AND settled_at IS NOT NULL AND cancelled_at IS NULL) OR
    (status = 'cancelled' AND settled_at IS NULL AND cancelled_at IS NOT NULL)
  )
);

ALTER TABLE orders
  ADD COLUMN fulfillment_status text NOT NULL DEFAULT 'queued'
    CHECK (fulfillment_status IN ('queued', 'ready', 'failed', 'cancelled')),
  ADD COLUMN fulfillment_updated_at timestamptz NOT NULL DEFAULT now();

-- Existing orders were accepted before asynchronous fulfillment was introduced.
UPDATE orders
   SET fulfillment_status = 'ready', fulfillment_updated_at = updated_at;

CREATE TABLE order_fulfillment_tasks (
  order_id uuid PRIMARY KEY REFERENCES orders(id),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'ready', 'failed', 'cancelled')),
  snapshot jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  failed_at timestamptz,
  voided_at timestamptz
);
CREATE INDEX order_fulfillment_tasks_queued_idx
  ON order_fulfillment_tasks (created_at, order_id) WHERE status = 'queued';

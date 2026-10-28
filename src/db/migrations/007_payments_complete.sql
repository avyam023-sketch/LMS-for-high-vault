-- Payments: record what Stripe actually charged (tax included), the payment intent used for refunds,
-- and refunds themselves.
ALTER TABLE payments DROP CONSTRAINT payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check CHECK (status IN ('pending', 'paid', 'failed', 'refunded'));
ALTER TABLE payments ADD COLUMN stripe_payment_intent text;
ALTER TABLE payments ADD COLUMN amount_paid_cents integer;
ALTER TABLE payments ADD COLUMN refunded_at timestamptz;
CREATE INDEX payments_intent_idx ON payments (stripe_payment_intent) WHERE stripe_payment_intent IS NOT NULL;

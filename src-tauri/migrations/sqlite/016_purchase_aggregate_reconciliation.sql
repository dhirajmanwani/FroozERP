-- Preserve one provisional purchase identity per intent and one stable identity per line.

ALTER TABLE local_purchase_intents
  ADD COLUMN provisional_purchase_id TEXT;

ALTER TABLE local_purchase_intent_lines
  ADD COLUMN provisional_line_id TEXT;

ALTER TABLE local_purchase_intent_lines
  ADD COLUMN server_purchase_item_id TEXT;

UPDATE local_purchase_intents
SET provisional_purchase_id = 'offline-purchase-' || operation_id
WHERE provisional_purchase_id IS NULL OR TRIM(provisional_purchase_id) = '';

UPDATE local_purchase_intent_lines
SET provisional_line_id = provisional_purchase_id
WHERE provisional_line_id IS NULL OR TRIM(provisional_line_id) = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_local_purchase_intents_provisional_purchase
  ON local_purchase_intents(provisional_purchase_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_local_purchase_lines_provisional_line
  ON local_purchase_intent_lines(provisional_line_id);
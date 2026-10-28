-- Short, readable references for support conversations, emails and admin search:
--   HV-L-XXXX-XXXX  learner (every account)
--   HV-E-XXXX-XXXX  exam attempt
--   HV-P-XXXX-XXXX  payment
-- Certificates keep their own HV-YYYY-XXXX-XXXX numbers. The alphabet leaves out 0/O and 1/I/L so codes
-- read out over the phone aren't misheard. 31^8 ≈ 850 billion combinations per prefix.
CREATE FUNCTION hv_reference(prefix text) RETURNS text
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  code text := '';
  b int;
BEGIN
  WHILE length(code) < 8 LOOP
    b := get_byte(gen_random_bytes(1), 0);
    -- Rejection sampling keeps every character equally likely (248 = 8 × 31).
    IF b < 248 THEN
      code := code || substr(alphabet, 1 + b % 31, 1);
    END IF;
  END LOOP;
  RETURN prefix || '-' || substr(code, 1, 4) || '-' || substr(code, 5, 4);
END;
$$;

-- A volatile default is evaluated per row, so existing rows get their own codes here too.
ALTER TABLE users ADD COLUMN reference text NOT NULL DEFAULT hv_reference('HV-L');
ALTER TABLE users ADD CONSTRAINT users_reference_key UNIQUE (reference);

ALTER TABLE exam_attempts ADD COLUMN reference text NOT NULL DEFAULT hv_reference('HV-E');
ALTER TABLE exam_attempts ADD CONSTRAINT exam_attempts_reference_key UNIQUE (reference);

ALTER TABLE payments ADD COLUMN reference text NOT NULL DEFAULT hv_reference('HV-P');
ALTER TABLE payments ADD CONSTRAINT payments_reference_key UNIQUE (reference);

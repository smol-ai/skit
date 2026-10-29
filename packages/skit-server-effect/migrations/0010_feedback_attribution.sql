-- Opt-in attribution for feedback. `principal_id` is the account whose Bearer token signed the
-- report; `contact_email` is an address the sender chose to give, never verified.
ALTER TABLE feedback ADD COLUMN principal_id TEXT;
ALTER TABLE feedback ADD COLUMN contact_email TEXT;

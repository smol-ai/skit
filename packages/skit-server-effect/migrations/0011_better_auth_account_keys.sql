-- Better Auth 1.7.3+ identifies accounts by providerId/accountId and no longer writes issuer.
-- Refuse ambiguous existing identities before removing the old constraint or any data.
CREATE UNIQUE INDEX idx_account_provider_account ON account(providerId, accountId);
DROP INDEX idx_account_issuer_account;
ALTER TABLE account DROP COLUMN issuer;

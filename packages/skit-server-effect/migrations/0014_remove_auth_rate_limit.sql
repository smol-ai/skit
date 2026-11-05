-- Better Auth's database rate limiter is disabled; Cloudflare bindings enforce limits.
-- Keep the historical creation migration intact for existing installations.
DROP TABLE rateLimit;

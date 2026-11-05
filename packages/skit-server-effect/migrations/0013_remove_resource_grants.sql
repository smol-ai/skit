-- Content access is namespace ownership or current team membership.
-- No application path creates or interprets resource grants. Dropping the table
-- also removes its lookup/subject indexes and obsolete grant rows.
DROP TABLE resource_grants;

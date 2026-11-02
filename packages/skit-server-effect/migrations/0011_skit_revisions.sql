-- The Registry SKIT identity owns its revisions and current pointer. There is
-- no separate Draft identity or lifecycle. Renaming preserves every row and
-- SQLite updates foreign-key references to the renamed tables.
ALTER TABLE drafts RENAME TO skits;
ALTER TABLE draft_trees RENAME TO revision_trees;
ALTER TABLE draft_tree_entries RENAME TO revision_tree_entries;
ALTER TABLE draft_revisions RENAME TO revisions;
ALTER TABLE draft_revision_parents RENAME TO revision_parents;

DROP INDEX idx_draft_revisions_tree;
CREATE INDEX idx_revisions_tree ON revisions(tree_hash);
DROP INDEX idx_draft_revision_parents_parent;
CREATE INDEX idx_revision_parents_parent ON revision_parents(owner_slug, skit_slug, parent_id);

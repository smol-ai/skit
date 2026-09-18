CREATE INDEX idx_namespaces_subject
  ON namespaces(subject_kind, subject_id, namespace_slug);

CREATE INDEX idx_resource_grants_subject
  ON resource_grants(subject_kind, subject_id, resource_kind, permission, resource_id);

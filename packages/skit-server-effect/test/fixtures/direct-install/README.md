---
skit: 1
slug: direct-install
skills:
  - name: direct-explicit
    path: skills/direct-explicit
    default_enabled: true
    invocation: explicit
  - name: direct-host
    path: skills/direct-host
    default_enabled: true
    invocation: host-policy
---

# Direct install

A public fixture Release whose contained Skills state their invocation policy in the metadata
Claude Code and Codex read, so the skills.sh CLI installs it without SKIT participating.

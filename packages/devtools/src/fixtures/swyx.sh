#!/usr/bin/env bash
# Real source content with the reported pre-SKIT layout. No upstream scripts are run.
set -euo pipefail
revision=7a57f05a9137c00cd75b81b1991c16dc800ef5fe
repository=https://github.com/swyxio/skills.git
source="$HOME/Work/skills"
links="$HOME/.codex/skills"

for path in "$HOME/.skit" "$source" "$source.partial" "$links" "$links.partial"; do
  if [ -e "$path" ] || [ -L "$path" ]; then
    echo "Fixture requires a fresh trial; already exists: $path" >&2
    exit 1
  fi
done

mkdir -p "$HOME/Work" "$HOME/.codex"
trap 'rm -rf "$source.partial" "$links.partial"' EXIT
git init -q "$source.partial"
git -C "$source.partial" remote add origin "$repository"
git -C "$source.partial" fetch --depth 1 origin "$revision"
git -C "$source.partial" checkout -q --detach FETCH_HEAD
test "$(git -C "$source.partial" rev-parse HEAD)" = "$revision"

count=0
for skill in "$source.partial"/*/SKILL.md; do
  test -f "$skill"
  count=$((count + 1))
done
test "$count" -eq 98

mkdir "$links.partial"
for skill in "$source.partial"/*/SKILL.md; do
  directory=$(basename "$(dirname "$skill")")
  ln -s "$source/$directory" "$links.partial/$directory"
done
mv "$source.partial" "$source"
mv "$links.partial" "$links"
cat > "$HOME/.skit-vm-fixture.json" <<JSON
{"fixture":"swyx","repository":"$repository","revision":"$revision","skills":98,"links":".codex/skills","cwd":"Work/skills","skitConfigured":false}
JSON
printf 'Seeded 98 source skills and 98 Codex symlinks at %s. SKIT is unconfigured.\n' "$revision"

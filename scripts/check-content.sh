#!/usr/bin/env bash
# Pre-build content checks. Run from the repository root:
#   bash scripts/check-content.sh
#
# 1. _config.yml must not contain the YOUR-USERNAME placeholder.
# 2. No page that will be published may contain a "[TODO" placeholder.
#    Pages with `published: false` in their front matter are drafts and are skipped.

set -euo pipefail

failed=0

if grep -n 'YOUR-USERNAME' _config.yml; then
  echo "::error file=_config.yml::Replace YOUR-USERNAME with your GitHub username"
  failed=1
fi

# Succeeds if the file's front matter (between the first two '---' lines)
# contains `published: false`. Tolerates Windows (CRLF) line endings.
is_draft() {
  awk '
    { sub(/\r$/, "") }
    NR == 1 { if ($0 != "---") exit; next }
    $0 == "---" { exit }
    /^published:[[:space:]]*false[[:space:]]*(#.*)?$/ { found = 1; exit }
    END { exit !found }
  ' "$1"
}

while IFS= read -r -d '' file; do
  is_draft "$file" && continue

  if matches=$(grep -n '\[TODO' "$file"); then
    while IFS= read -r match; do
      echo "::error file=${file#./},line=${match%%:*}::Unresolved [TODO] placeholder in a published page"
    done <<< "$matches"
    failed=1
  fi
done < <(find . -type f -name '*.md' \
           -not -path './.git/*' \
           -not -path './_site/*' \
           -not -path './vendor/*' \
           -not -path './_templates/*' \
           -not -name 'README.md' \
           -not -name 'GUIDE.md' \
           -print0)

if (( failed )); then
  echo "Content check failed: fix the errors above, or mark unfinished pages with 'published: false'." >&2
  exit 1
fi

echo "Content check passed."

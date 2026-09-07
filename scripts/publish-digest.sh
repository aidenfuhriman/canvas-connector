#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

if ! node dist/reminder/digest.js > digest-latest.txt 2>digest-latest.err; then
  {
    echo "Upcoming Assignments (next 7 days):"
    echo "  Could not fetch Canvas data this morning."
    echo ""
    echo "Today's Canvas Schedule:"
    echo "  Could not fetch Canvas data this morning."
    echo ""
    echo "(error: $(cat digest-latest.err | tail -1))"
  } > digest-latest.txt
fi
rm -f digest-latest.err

git add digest-latest.txt
if ! git diff --cached --quiet; then
  git commit -m "chore: update digest-latest.txt ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  git push
else
  git reset digest-latest.txt >/dev/null
fi

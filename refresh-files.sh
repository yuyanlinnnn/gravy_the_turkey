#!/bin/bash
# Makes files.json: a list of recent files in Desktop / Documents so "gravy, upload ..." can offer them.
# (Files you DOWNLOAD with Chrome are listed live — no need to run this for those.)
# Run it once before you start working:   cd ~/Desktop/handsfree-pet && bash refresh-files.sh
cd "$(dirname "$0")" || exit 1
ROOTS=("$HOME/Desktop" "$HOME/Documents")
mt() { if stat -f %m "$1" >/dev/null 2>&1; then stat -f %m "$1"; else stat -c %Y "$1"; fi; }
tmp=$(mktemp)
for r in "${ROOTS[@]}"; do
  [ -d "$r" ] || continue
  find "$r" -maxdepth 3 -type f ! -name '.*' ! -path '*/handsfree-pet/*' ! -path '*/node_modules/*' ! -path '*/.git/*' \
       ! -name '*.app' ! -name '*.lnk' -print 2>/dev/null | while IFS= read -r f; do printf '%s\t%s\n' "$(mt "$f")" "$f"; done >> "$tmp"
done
{
  echo '{"files":['
  sort -rn "$tmp" | head -300 | awk -F'\t' 'BEGIN{n=0} {p=$2; gsub(/\\/,"\\\\",p); gsub(/"/,"\\\"",p); printf "%s{\"path\":\"%s\",\"t\":%d000}", (n++?",\n":""), p, $1} END{print ""}'
  echo ']}'
} > files.json
rm -f "$tmp"
echo "files.json updated: $(grep -c '"path"' files.json) files"

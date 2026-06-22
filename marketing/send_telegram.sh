#!/usr/bin/env bash
# Ember CMO → Telegram sender. Usage:
#   ./send_telegram.sh msg "text"
#   ./send_telegram.sh photo /path/img.png "caption"
#   ./send_telegram.sh album "caption" img1.png img2.png ...   (up to 10)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/.telegram.env"
API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"
CID="$TELEGRAM_CHAT_ID"

case "${1:-}" in
  msg)
    curl -s -X POST "$API/sendMessage" -d chat_id="$CID" \
      --data-urlencode "text=${2:-}" -d parse_mode=Markdown >/dev/null && echo sent ;;
  photo)
    curl -s -X POST "$API/sendPhoto" -F chat_id="$CID" \
      -F photo=@"$2" --form-string "caption=${3:-}" >/dev/null && echo sent ;;
  doc)
    curl -s -X POST "$API/sendDocument" -F chat_id="$CID" \
      -F document=@"$2" --form-string "caption=${3:-}" >/dev/null && echo sent ;;
  album)
    cap="$2"; shift 2
    media="["; i=0
    args=()
    for f in "$@"; do
      [ $i -gt 0 ] && media+=","
      if [ $i -eq 0 ]; then
        media+="{\"type\":\"photo\",\"media\":\"attach://p$i\",\"caption\":\"$cap\"}"
      else
        media+="{\"type\":\"photo\",\"media\":\"attach://p$i\"}"
      fi
      args+=(-F "p$i=@$f"); i=$((i+1))
    done
    media+="]"
    curl -s -X POST "$API/sendMediaGroup" -F chat_id="$CID" \
      -F "media=$media" "${args[@]}" >/dev/null && echo sent ;;
  *) echo "usage: $0 {msg|photo|doc|album} ..." >&2; exit 1 ;;
esac

#!/usr/bin/env bash
# Long-poll Telegram for the next user reply. Exits when a message arrives
# (prints "REPLY: <text>") or after MAX_MIN minutes (prints "TIMEOUT").
# The harness re-invokes the agent when this background command exits.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/.telegram.env"
API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"
CID="$TELEGRAM_CHAT_ID"
MAX_MIN="${1:-55}"

# Baseline: ignore everything already in the queue (test ping, /start, prior picks).
base=$(curl -s "$API/getUpdates?offset=-1" | python3 -c "import sys,json
d=json.load(sys.stdin).get('result',[])
print(d[-1]['update_id'] if d else 0)")
offset=$((base + 1))

deadline=$(( $(date +%s) + MAX_MIN*60 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  resp=$(curl -s "$API/getUpdates?timeout=45&offset=$offset" || true)
  hit=$(printf '%s' "$resp" | python3 -c "import sys,json
try: d=json.load(sys.stdin).get('result',[])
except Exception: d=[]
for u in d:
    m=u.get('message') or u.get('channel_post') or {}
    if str(m.get('chat',{}).get('id'))=='$CID' and 'text' in m:
        print(str(u['update_id'])+'\t'+m['text'].replace(chr(10),' ')); break")
  if [ -n "$hit" ]; then
    uid=${hit%%$'\t'*}; txt=${hit#*$'\t'}
    curl -s "$API/getUpdates?offset=$((uid+1))" >/dev/null   # ack/clear
    echo "REPLY: $txt"
    exit 0
  fi
  # advance offset past any non-text updates we saw
  newoff=$(printf '%s' "$resp" | python3 -c "import sys,json
try: d=json.load(sys.stdin).get('result',[])
except Exception: d=[]
print(d[-1]['update_id']+1 if d else 0)")
  [ "${newoff:-0}" -gt 0 ] && offset=$newoff
done
echo "TIMEOUT"
exit 0

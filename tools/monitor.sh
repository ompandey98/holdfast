#!/usr/bin/env bash
# READ-ONLY Holdfast monitor. Samples every 30s. Never starts/stops/changes anything.
# Writes one block per sample to the output log so we can review after the fact.
OUT="${1:-/tmp/holdfast-monitor.log}"
LOG=/Users/pandeom/.holdfast/holdfast.log
PORTS=8787-8790

# Remember how many lines the daemon log had at start, so we can show only NEW events.
base_lines=$(wc -l < "$LOG" 2>/dev/null | tr -d ' ')
base_lines=${base_lines:-0}

echo "monitor started (pid $$), sampling every 30s → $OUT" >> "$OUT"

while true; do
  ts=$(date '+%Y-%m-%d %H:%M:%S')
  {
    echo "===== $ts ====="

    # 1) Is the daemon alive, and what is its CPU/mem? (a runaway loop would show high CPU)
    #    Use the process actually LISTENING on the ports — the real node daemon,
    #    not the npm-exec wrapper.
    dpid=$(lsof -nP -iTCP:$PORTS -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $2}')
    if [ -n "$dpid" ]; then
      ps -o pid=,%cpu=,%mem=,etime=,command= -p "$dpid" 2>/dev/null | sed 's/^/  proc: /'
    else
      echo "  proc: NO LISTENER on $PORTS (daemon down?)"
    fi

    # 2) Live connections THROUGH Holdfast (this is the real "is anything routed / stuck" signal)
    est=$(lsof -nP -iTCP:$PORTS -sTCP:ESTABLISHED 2>/dev/null | grep -v COMMAND)
    if [ -n "$est" ]; then
      echo "  ESTABLISHED conns:"
      echo "$est" | sed 's/^/    /'
    else
      echo "  ESTABLISHED conns: none (nothing routed through Holdfast)"
    fi

    # 3) Any NEW daemon-log events since we started (holds, drops, SAVED, give-ups, errors)
    now_lines=$(wc -l < "$LOG" 2>/dev/null | tr -d ' '); now_lines=${now_lines:-0}
    if [ "$now_lines" -gt "$base_lines" ]; then
      new=$(tail -n +"$((base_lines+1))" "$LOG" | grep -Ei 'DISCONNECT|hold|GAVE UP|SAVED|probe|replay|error|in-flight')
      [ -n "$new" ] && { echo "  NEW daemon events:"; echo "$new" | sed 's/^/    /'; }
    fi
  } >> "$OUT" 2>&1
  sleep 30
done

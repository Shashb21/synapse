#!/usr/bin/env bash
# Record runner pressure in the live log, even if the runner cannot upload artifacts.
set -eu

while true; do
  date -u '+%Y-%m-%dT%H:%M:%SZ runner resources'
  free -m
  df -h / /tmp
  ps -eo pid,ppid,rss,comm --sort=-rss | head -16 || true
  for metric in memory.current memory.max memory.events memory.pressure; do
    if [[ -r "/sys/fs/cgroup/$metric" ]]; then
      echo "$metric"
      cat "/sys/fs/cgroup/$metric"
    fi
  done
  sleep 20
done

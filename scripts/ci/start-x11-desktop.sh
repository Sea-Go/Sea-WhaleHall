#!/usr/bin/env bash
set -euo pipefail

: "${DISPLAY:?DISPLAY must identify the X11 server to start}"

window_title="${1:-WhaleHallSensorProbe}"
xvfb_log=/tmp/whalehall-xvfb.log
openbox_log=/tmp/whalehall-openbox.log
xterm_log=/tmp/whalehall-xterm.log

nohup Xvfb "$DISPLAY" -screen 0 1280x720x24 >"$xvfb_log" 2>&1 &
display_ready=false
for _ in {1..40}; do
  if xdpyinfo >/dev/null 2>&1; then
    display_ready=true
    break
  fi
  sleep 0.25
done
if [[ "$display_ready" != "true" ]]; then
  cat "$xvfb_log" >&2
  exit 1
fi

nohup openbox >"$openbox_log" 2>&1 &
window_manager_ready=false
for _ in {1..40}; do
  if wmctrl -m 2>/dev/null | grep -q "^Name: Openbox$"; then
    window_manager_ready=true
    break
  fi
  sleep 0.25
done
if [[ "$window_manager_ready" != "true" ]]; then
  cat "$openbox_log" >&2
fi

nohup xterm -T "$window_title" >"$xterm_log" 2>&1 &
xterm_pid=$!

probe_window=""
for _ in {1..40}; do
  probe_window=$(xdotool search --limit 1 --pid "$xterm_pid" 2>/dev/null || true)
  if [[ -n "$probe_window" ]]; then
    break
  fi
  sleep 0.25
done
if [[ -z "$probe_window" ]]; then
  cat "$openbox_log" "$xterm_log" >&2
  exit 1
fi

desktop_ready=false
for _ in {1..40}; do
  wmctrl -i -a "$probe_window" >/dev/null 2>&1 || true
  xdotool windowactivate "$probe_window" >/dev/null 2>&1 || true
  xdotool windowfocus "$probe_window" >/dev/null 2>&1 || true
  if [[ "$(xdotool getactivewindow 2>/dev/null || true)" == "$probe_window" ]]; then
    desktop_ready=true
    break
  fi
  sleep 0.25
done
if [[ "$desktop_ready" != "true" ]]; then
  cat "$openbox_log" "$xterm_log" >&2
  xprop -root _NET_SUPPORTING_WM_CHECK _NET_ACTIVE_WINDOW >&2 || true
  wmctrl -l >&2 || true
  xdotool getactivewindow getwindowname >&2 || true
  exit 1
fi

xdpyinfo >/dev/null

#!/bin/sh

printf '%s\n' "$$" > "${WHALEHALL_DATA_DIR}/leader.pid"
(
	trap '' HUP INT TERM
	while :; do
		sleep 1
	done
) &
printf '%s\n' "$!" > "${WHALEHALL_DATA_DIR}/observer.pid"

sleep 0.05
kill -KILL "$$"

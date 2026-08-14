#!/bin/sh

trap '' HUP INT TERM
printf '%s\n' "$$" > "${WHALEHALL_DATA_DIR}/leader.pid"
(
	trap '' HUP INT TERM
	while :; do
		sleep 1
	done
) &
printf '%s\n' "$!" > "${WHALEHALL_DATA_DIR}/observer.pid"

printf '%s\n' 'not-json'
while :; do
	sleep 1
done

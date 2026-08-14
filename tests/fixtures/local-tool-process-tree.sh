#!/bin/sh

trap '' HUP INT TERM

(
	trap '' HUP INT TERM
	while :; do
		sleep 1
	done
) &
observer_pid=$!
printf '%s\n' "$observer_pid" > "${WHALEHALL_DATA_DIR}/observer.pid"

# The leader exits normally on stdin EOF, while its Observer deliberately
# survives EOF and ordinary termination. The integration test proves the POSIX
# path detects the still-live group and removes it instead of trusting exit(0).
while IFS= read -r _line; do
	:
done
printf '%s\n' "leader-exited" > "${WHALEHALL_DATA_DIR}/leader-exited"
exit 0

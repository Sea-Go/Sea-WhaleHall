#!/usr/bin/env bash

set -euo pipefail

readonly datacenter_gitlab_origin="https://gitlab.sea-ridethewindbreakthewaves.xyz"
readonly whalehall_repository_url="https://github.com/Sea-Go/Sea-WhaleHall.git"
readonly pipeline_deadline_ceiling_seconds=3600
readonly pipeline_deadline_seconds="${DATACENTER_PIPELINE_DEADLINE_SECONDS:-$pipeline_deadline_ceiling_seconds}"
readonly poll_interval_seconds=15
readonly status_timeout_retry_limit=3
readonly status_timeout_retry_backoff_seconds=2

# Keep the complete trigger-and-wait operation below the workflow's 65-minute
# timeout, including bounded API requests and cleanup.
SECONDS=0

: "${WHALEHALL_CANDIDATE_SHA:?WHALEHALL_CANDIDATE_SHA is required}"
: "${DATACENTER_GITLAB_PROJECT_ID:?DATACENTER_GITLAB_PROJECT_ID is required}"
: "${DATACENTER_GITLAB_REF:?DATACENTER_GITLAB_REF is required}"
: "${DATACENTER_GITLAB_TRIGGER_TOKEN:?DATACENTER_GITLAB_TRIGGER_TOKEN is required}"
: "${DATACENTER_GITLAB_API_TOKEN:?DATACENTER_GITLAB_API_TOKEN is required}"

if [[ ! "$pipeline_deadline_seconds" =~ ^[1-9][0-9]*$ ]] ||
	((pipeline_deadline_seconds > pipeline_deadline_ceiling_seconds)); then
	echo "DATACENTER_PIPELINE_DEADLINE_SECONDS must be an integer from 1 through $pipeline_deadline_ceiling_seconds." >&2
	exit 1
fi
if [[ ! "$WHALEHALL_CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
	echo "WHALEHALL_CANDIDATE_SHA must be a lowercase 40-character commit SHA." >&2
	exit 1
fi
if [[ ! "$DATACENTER_GITLAB_PROJECT_ID" =~ ^[1-9][0-9]*$ ]]; then
	echo "DATACENTER_GITLAB_PROJECT_ID must be a numeric GitLab project ID." >&2
	exit 1
fi
if [[ ! "$DATACENTER_GITLAB_REF" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$ ]] ||
	[[ "$DATACENTER_GITLAB_REF" == *..* ]] ||
	[[ "$DATACENTER_GITLAB_REF" == */ ]] ||
	[[ "$DATACENTER_GITLAB_REF" == *//* ]]; then
	echo "DATACENTER_GITLAB_REF is invalid." >&2
	exit 1
fi

work_dir=$(mktemp -d)
# Invoked indirectly by the EXIT trap below.
# shellcheck disable=SC2317,SC2329
cleanup() {
	rm -f "$work_dir/trigger.json" "$work_dir/pipeline.json"
	rmdir "$work_dir"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

trigger_url="$datacenter_gitlab_origin/api/v4/projects/$DATACENTER_GITLAB_PROJECT_ID/trigger/pipeline"
curl --fail-with-body --silent --show-error \
	--connect-timeout 10 --max-time 30 \
	--request POST \
	--form-string "token=$DATACENTER_GITLAB_TRIGGER_TOKEN" \
	--form-string "ref=$DATACENTER_GITLAB_REF" \
	--form-string "variables[WHALEHALL_CANDIDATE_SHA]=$WHALEHALL_CANDIDATE_SHA" \
	--form-string "variables[WHALEHALL_REPOSITORY_URL]=$whalehall_repository_url" \
	--output "$work_dir/trigger.json" \
	"$trigger_url"

pipeline_id=$(jq -er '.id | numbers | floor | select(. > 0)' "$work_dir/trigger.json")
pipeline_url=$(jq -er '.web_url | strings | select(startswith("https://"))' "$work_dir/trigger.json")
echo "Triggered DataCenter pipeline $pipeline_id for WhaleHall $WHALEHALL_CANDIDATE_SHA"
echo "DataCenter pipeline: $pipeline_url"

status_url="$datacenter_gitlab_origin/api/v4/projects/$DATACENTER_GITLAB_PROJECT_ID/pipelines/$pipeline_id"
consecutive_status_timeouts=0
while ((SECONDS < pipeline_deadline_seconds)); do
	remaining_seconds=$((pipeline_deadline_seconds - SECONDS))
	request_timeout_seconds=30
	if ((remaining_seconds < request_timeout_seconds)); then
		request_timeout_seconds=$remaining_seconds
	fi
	if curl --fail-with-body --silent --show-error \
		--connect-timeout 10 --max-time "$request_timeout_seconds" \
		--header "PRIVATE-TOKEN: $DATACENTER_GITLAB_API_TOKEN" \
		--output "$work_dir/pipeline.json" \
		"$status_url"; then
		consecutive_status_timeouts=0
	else
		curl_status=$?
		if ((SECONDS >= pipeline_deadline_seconds)); then
			break
		fi
		if ((curl_status != 28)); then
			echo "Failed to read DataCenter integration pipeline status (curl exit $curl_status): $pipeline_url" >&2
			exit 1
		fi

		consecutive_status_timeouts=$((consecutive_status_timeouts + 1))
		if ((consecutive_status_timeouts > status_timeout_retry_limit)); then
			echo "Failed to read DataCenter integration pipeline status after $status_timeout_retry_limit timeout retries: $pipeline_url" >&2
			exit 1
		fi

		remaining_seconds=$((pipeline_deadline_seconds - SECONDS))
		retry_sleep_seconds=$((status_timeout_retry_backoff_seconds << (consecutive_status_timeouts - 1)))
		if ((remaining_seconds < retry_sleep_seconds)); then
			retry_sleep_seconds=$remaining_seconds
		fi
		echo "DataCenter integration pipeline status read timed out; retry $consecutive_status_timeouts/$status_timeout_retry_limit in $retry_sleep_seconds seconds: $pipeline_url" >&2
		if ((retry_sleep_seconds > 0)); then
			sleep "$retry_sleep_seconds"
		fi
		continue
	fi
	if ((SECONDS >= pipeline_deadline_seconds)); then
		break
	fi
	if ! status=$(jq -er '.status | strings' "$work_dir/pipeline.json"); then
		echo "DataCenter integration pipeline returned invalid status JSON: $pipeline_url" >&2
		exit 1
	fi
	if ((SECONDS >= pipeline_deadline_seconds)); then
		break
	fi
	case "$status" in
		success)
			echo "DataCenter integration pipeline succeeded: $pipeline_url"
			exit 0
			;;
		failed|canceled|skipped|manual)
			echo "DataCenter integration pipeline finished with status '$status': $pipeline_url" >&2
			exit 1
			;;
		created|waiting_for_resource|preparing|pending|running|scheduled)
			remaining_seconds=$((pipeline_deadline_seconds - SECONDS))
			sleep_seconds=$poll_interval_seconds
			if ((remaining_seconds < sleep_seconds)); then
				sleep_seconds=$remaining_seconds
			fi
			if ((sleep_seconds > 0)); then
				sleep "$sleep_seconds"
			fi
			;;
		*)
			echo "DataCenter integration pipeline returned unknown status '$status'." >&2
			exit 1
			;;
	esac
done

echo "Timed out after $pipeline_deadline_seconds seconds waiting for DataCenter integration pipeline: $pipeline_url" >&2
exit 1

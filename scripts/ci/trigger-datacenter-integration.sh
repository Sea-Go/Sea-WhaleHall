#!/usr/bin/env bash

set -euo pipefail

readonly datacenter_gitlab_origin="https://gitlab.sea-ridethewindbreakthewaves.xyz"

: "${WHALEHALL_CANDIDATE_SHA:?WHALEHALL_CANDIDATE_SHA is required}"
: "${DATACENTER_GITLAB_PROJECT_ID:?DATACENTER_GITLAB_PROJECT_ID is required}"
: "${DATACENTER_GITLAB_REF:?DATACENTER_GITLAB_REF is required}"
: "${DATACENTER_GITLAB_TRIGGER_TOKEN:?DATACENTER_GITLAB_TRIGGER_TOKEN is required}"
: "${DATACENTER_GITLAB_API_TOKEN:?DATACENTER_GITLAB_API_TOKEN is required}"

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
	--output "$work_dir/trigger.json" \
	"$trigger_url"

pipeline_id=$(jq -er '.id | numbers | floor | select(. > 0)' "$work_dir/trigger.json")
pipeline_url=$(jq -er '.web_url | strings | select(startswith("https://"))' "$work_dir/trigger.json")
echo "Triggered DataCenter pipeline $pipeline_id for WhaleHall $WHALEHALL_CANDIDATE_SHA"
echo "DataCenter pipeline: $pipeline_url"

status_url="$datacenter_gitlab_origin/api/v4/projects/$DATACENTER_GITLAB_PROJECT_ID/pipelines/$pipeline_id"
for _ in $(seq 1 240); do
	curl --fail-with-body --silent --show-error \
		--connect-timeout 10 --max-time 30 \
		--header "PRIVATE-TOKEN: $DATACENTER_GITLAB_API_TOKEN" \
		--output "$work_dir/pipeline.json" \
		"$status_url"
	status=$(jq -er '.status | strings' "$work_dir/pipeline.json")
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
			sleep 15
			;;
		*)
			echo "DataCenter integration pipeline returned unknown status '$status'." >&2
			exit 1
			;;
	esac
done

echo "Timed out waiting for DataCenter integration pipeline: $pipeline_url" >&2
exit 1

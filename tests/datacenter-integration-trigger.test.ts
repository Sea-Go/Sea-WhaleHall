import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = join(
	import.meta.dir,
	"..",
	"scripts",
	"ci",
	"trigger-datacenter-integration.sh",
);
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("DataCenter integration trigger status polling", () => {
	test("recovers after one temporary status read timeout", async () => {
		const result = await runTrigger("timeout-once");

		expect(result.exitCode).toBe(0);
		expect(result.statusRequests).toEqual(["1:30", "2:30"]);
		expect(result.sleeps).toEqual(["2"]);
		expect(result.stderr).toContain("retry 1/3 in 2 seconds");
		expect(result.stdout).toContain(
			"DataCenter integration pipeline succeeded",
		);
	});

	test("backs off and recovers after multiple temporary status read timeouts", async () => {
		const result = await runTrigger("timeout-twice");

		expect(result.exitCode).toBe(0);
		expect(result.statusRequests).toEqual(["1:30", "2:30", "3:30"]);
		expect(result.sleeps).toEqual(["2", "4"]);
		expect(result.stderr).toContain("retry 2/3 in 4 seconds");
	});

	test("stops after the bounded number of consecutive timeout retries", async () => {
		const result = await runTrigger("always-timeout");

		expect(result.exitCode).toBe(1);
		expect(result.statusRequests).toEqual(["1:30", "2:30", "3:30", "4:30"]);
		expect(result.sleeps).toEqual(["2", "4", "8"]);
		expect(result.stderr).toContain("after 3 timeout retries");
	});

	test("does not retry beyond the shared pipeline deadline", async () => {
		const result = await runTrigger("delayed-timeout", {
			DATACENTER_PIPELINE_DEADLINE_SECONDS: "5",
		});

		expect(result.exitCode).toBe(1);
		expect(result.statusRequests).toHaveLength(1);
		const requestTimeout = Number(result.statusRequests[0]?.split(":")[1]);
		expect(requestTimeout).toBeGreaterThan(0);
		expect(requestTimeout).toBeLessThanOrEqual(5);
		expect(result.sleeps).toEqual([]);
		expect(result.stderr).toContain(
			"Timed out after 5 seconds waiting for DataCenter integration pipeline",
		);
	}, 10_000);

	test("fails non-timeout curl errors without retrying", async () => {
		const result = await runTrigger("http-error");

		expect(result.exitCode).toBe(1);
		expect(result.statusRequests).toEqual(["1:30"]);
		expect(result.sleeps).toEqual([]);
		expect(result.stderr).toContain("curl exit 22");
	});

	test("fails invalid status JSON without retrying", async () => {
		const result = await runTrigger("invalid-json");

		expect(result.exitCode).toBe(1);
		expect(result.statusRequests).toEqual(["1:30"]);
		expect(result.sleeps).toEqual([]);
		expect(result.stderr).toContain("returned invalid status JSON");
	});
});

async function runTrigger(
	scenario: string,
	environment: Record<string, string> = {},
): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
	statusRequests: string[];
	sleeps: string[];
}> {
	const directory = mkdtempSync(
		join(tmpdir(), "whalehall-datacenter-trigger-"),
	);
	temporaryDirectories.push(directory);
	const executableDirectory = join(directory, "bin");
	mkdirSync(executableDirectory);
	const curlLogPath = join(directory, "curl.log");
	const curlStatePath = join(directory, "curl.state");
	const sleepLogPath = join(directory, "sleep.log");

	writeExecutable(join(executableDirectory, "curl"), fakeCurlScript);
	writeExecutable(join(executableDirectory, "sleep"), fakeSleepScript);

	const child = Bun.spawn(["/bin/bash", scriptPath], {
		env: {
			...process.env,
			PATH: `${executableDirectory}:${process.env.PATH ?? ""}`,
			WHALEHALL_CANDIDATE_SHA: "a".repeat(40),
			DATACENTER_GITLAB_PROJECT_ID: "42",
			DATACENTER_GITLAB_REF: "main",
			DATACENTER_GITLAB_TRIGGER_TOKEN: "trigger-token",
			DATACENTER_GITLAB_API_TOKEN: "api-token",
			DATACENTER_PIPELINE_DEADLINE_SECONDS: "3600",
			FAKE_CURL_SCENARIO: scenario,
			FAKE_CURL_LOG: curlLogPath,
			FAKE_CURL_STATE: curlStatePath,
			FAKE_SLEEP_LOG: sleepLogPath,
			...environment,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);

	return {
		exitCode,
		stdout,
		stderr,
		statusRequests: readLines(curlLogPath),
		sleeps: readLines(sleepLogPath),
	};
}

function writeExecutable(path: string, contents: string): void {
	writeFileSync(path, contents, { mode: 0o700 });
	chmodSync(path, 0o700);
}

function readLines(path: string): string[] {
	try {
		return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

const fakeCurlScript = `#!/usr/bin/env bash
set -euo pipefail

output_path=""
max_time=""
request_method="GET"
while (($# > 0)); do
	case "$1" in
		--output|--max-time|--connect-timeout|--header|--form-string)
			if [[ "$1" == "--output" ]]; then
				output_path="$2"
			elif [[ "$1" == "--max-time" ]]; then
				max_time="$2"
			fi
			shift 2
			;;
		--request)
			request_method="$2"
			shift 2
			;;
		--fail-with-body|--silent|--show-error)
			shift
			;;
		*)
			shift
			;;
	esac
done

if [[ "$request_method" == "POST" ]]; then
	printf '%s' '{"id":78,"web_url":"https://gitlab.example/pipelines/78"}' >"$output_path"
	exit 0
fi

request_count=0
if [[ -f "$FAKE_CURL_STATE" ]]; then
	request_count=$(<"$FAKE_CURL_STATE")
fi
request_count=$((request_count + 1))
printf '%s' "$request_count" >"$FAKE_CURL_STATE"
printf '%s:%s\n' "$request_count" "$max_time" >>"$FAKE_CURL_LOG"

case "$FAKE_CURL_SCENARIO" in
	timeout-once)
		if ((request_count == 1)); then exit 28; fi
		;;
	timeout-twice)
		if ((request_count <= 2)); then exit 28; fi
		;;
	always-timeout)
		exit 28
		;;
	delayed-timeout)
		/bin/sleep "$max_time"
		exit 28
		;;
	http-error)
		exit 22
		;;
	invalid-json)
		printf '%s' '{"status":' >"$output_path"
		exit 0
		;;
	*)
		echo "unknown fake curl scenario: $FAKE_CURL_SCENARIO" >&2
		exit 2
		;;
esac

printf '%s' '{"status":"success"}' >"$output_path"
`;

const fakeSleepScript = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" >>"$FAKE_SLEEP_LOG"
`;

/** Opt-in live RTW/UserCenter handoff; ready JSON is 0600 and never logged. */
import { readFileSync } from "node:fs";
import {
	RTWCloudHistoryClient,
	RTWCloudHistoryError,
} from "../src/bun/clients/product/rtw-cloud-history-client";

const readyPath = process.env.RTW_CLOUD_HISTORY_READY;
if (!readyPath) throw new Error("RTW_CLOUD_HISTORY_READY is required");
const readVersion = process.env.RTW_CLOUD_HISTORY_READ_VERSION ?? "v1";
if (readVersion !== "v1" && readVersion !== "v2")
	throw new Error("RTW_CLOUD_HISTORY_READ_VERSION must be v1 or v2");
const expectedOtherItemsRaw =
	process.env.RTW_CLOUD_HISTORY_EXPECTED_OTHER_ACCOUNT_ITEMS ?? "0";
if (!/^(?:0|[1-9][0-9]*)$/u.test(expectedOtherItemsRaw))
	throw new Error(
		"RTW_CLOUD_HISTORY_EXPECTED_OTHER_ACCOUNT_ITEMS must be a count",
	);
const expectedOtherItems = Number(expectedOtherItemsRaw);
if (!Number.isSafeInteger(expectedOtherItems) || expectedOtherItems > 20)
	throw new Error(
		"RTW_CLOUD_HISTORY_EXPECTED_OTHER_ACCOUNT_ITEMS is out of range",
	);
const ready = JSON.parse(readFileSync(readyPath, "utf8")) as {
	stage: string;
	base_url: string;
	product_token: string;
	other_token: string;
	session_id: string;
	answer_ids: string[];
	accepted_ordinals: number[];
	expected_statuses: Array<"succeeded" | "insufficient">;
	expected_quote: string;
	expected_citation_states: Array<{
		answer_id: string;
		evidence_id: string;
		revision_id: string;
		state: "available" | "unavailable";
	}>;
};
const clientFor = (token: string) => {
	const product = {
		accessToken: token,
		sessionId: "live-handoff",
		generation: 1,
	};
	return new RTWCloudHistoryClient({
		baseUrl: ready.base_url,
		readVersion,
		sessions: {
			current: async () => product,
			isCurrent: (value) =>
				value.accessToken === product.accessToken &&
				value.generation === product.generation &&
				value.sessionId === product.sessionId,
		},
	});
};
const client = clientFor(ready.product_token);
const seen = [];
let afterOrdinal = 0;
for (let index = 0; index < ready.answer_ids.length; index++) {
	const result = await client.list({
		logicalSessionId: ready.session_id,
		afterOrdinal,
		limit: 1,
	});
	const answer = result.items[0];
	if (
		!answer ||
		result.items.length !== 1 ||
		answer.answerId !== ready.answer_ids[index] ||
		answer.acceptedOrdinal !== ready.accepted_ordinals[index] ||
		answer.status !== ready.expected_statuses[index]
	) {
		throw new Error(`live answer mismatch at page ${index + 1}`);
	}
	const detail = await client.detail(ready.session_id, answer.answerId);
	if (JSON.stringify(detail) !== JSON.stringify(answer))
		throw new Error(`live detail mismatch at page ${index + 1}`);
	const expected = ready.expected_citation_states.find(
		(value) => value.answer_id === answer.answerId,
	);
	if (expected) {
		const actual = answer.citations.find(
			(value) => value.evidenceId === expected.evidence_id,
		);
		if (
			!actual ||
			actual.revisionId !== expected.revision_id ||
			actual.state !== expected.state ||
			"quote" in actual ||
			answer.citationState !== "verified" ||
			(expected.state === "available" &&
				!actual.excerpt?.includes(ready.expected_quote)) ||
			(expected.state === "unavailable" && actual.excerpt !== undefined)
		) {
			throw new Error(`live citation mismatch at page ${index + 1}`);
		}
	}
	seen.push({
		ordinal: answer.acceptedOrdinal,
		citationState: answer.citations[0]?.state ?? null,
		excerptVisible: Boolean(answer.citations[0]?.excerpt),
	});
	afterOrdinal = result.nextOrdinal ?? 0;
}
const other = await clientFor(ready.other_token).list({
	logicalSessionId: ready.session_id,
	limit: 20,
});
const otherAccountTargetItems = other.items.filter((answer) =>
	ready.answer_ids.includes(answer.answerId),
).length;
if (other.items.length !== expectedOtherItems || otherAccountTargetItems !== 0)
	throw new Error(
		"other account received target answers or lost its own answer",
	);
if (ready.answer_ids[0]) {
	try {
		await clientFor(ready.other_token).detail(
			ready.session_id,
			ready.answer_ids[0],
		);
		throw new Error("other account received answer detail");
	} catch (error) {
		if (!(error instanceof RTWCloudHistoryError) || error.code !== "NOT_FOUND")
			throw error;
	}
}
console.log(
	JSON.stringify({
		stage: ready.stage,
		readVersion,
		answers: seen,
		otherAccountItems: other.items.length,
		otherAccountTargetItems,
		quoteFieldExposed: false,
	}),
);

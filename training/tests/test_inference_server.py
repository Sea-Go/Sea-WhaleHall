from __future__ import annotations

import hashlib
import json
import threading
import unittest
import urllib.error
import urllib.request
from typing import Mapping

from whalehall_training.contracts import ACTIVITY_LABELS, GOAL_RELEVANCE_LABELS
from whalehall_training.inference_server import (
    INFERENCE_PATH,
    InferenceApplication,
    InferenceProtocolError,
    ModernBertRequest,
    create_inference_server,
    temperature_scaled_probabilities,
    validate_request,
)


def model_input(goal_text: str | None = "Ship the inference server") -> str:
    goal = (
        "null"
        if goal_text is None
        else json.dumps(
            {
                "goalId": "goal-1",
                "planId": None,
                "text": goal_text,
                "version": 3,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
    )
    event = json.dumps(
        {
            "cursor": "cursor-1",
            "eventId": "event-1",
            "goalVersion": 3 if goal_text is not None else None,
            "kind": "editor.documentChanged",
            "occurredAtMs": 1_000,
            "payload": {"insertedChars": 10},
            "source": "vscode",
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return (
        f"[GOAL]\n{goal}\n[CONTEXT_ONLY]\n(none)\n"
        f"[EVENTS]\n{event}"
    )


def request_value(has_goal: bool = True) -> dict[str, object]:
    text = model_input("Ship the inference server" if has_goal else None)
    return {
        "schemaVersion": "modernbert-request.v1",
        "windowId": "window-1",
        "inputHash": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "modelInput": text,
        "hasGoal": has_goal,
        "goalText": "Ship the inference server" if has_goal else None,
        "goalVersion": 3 if has_goal else None,
        "taxonomyVersion": "activity-taxonomy.v1",
    }


class MockRunner:
    model_version = "modernbert-whalehall-test"
    taxonomy_version = "activity-taxonomy.v1"

    def __init__(self) -> None:
        self.requests: list[ModernBertRequest] = []

    def infer(self, request: ModernBertRequest) -> Mapping[str, object]:
        self.requests.append(request)
        activity = {
            label: (1.0 if index == 0 else 0.0)
            for index, label in enumerate(ACTIVITY_LABELS)
        }
        relevance = {
            label: (1.0 if index == 0 else 0.0)
            for index, label in enumerate(GOAL_RELEVANCE_LABELS)
        }
        return {
            "schemaVersion": "modernbert-inference.v1",
            "modelVersion": self.model_version,
            "taxonomyVersion": self.taxonomy_version,
            "windowId": request.window_id,
            "inputHash": request.input_hash,
            "activityProbabilities": activity,
            "goalRelevanceProbabilities": relevance if request.has_goal else None,
            "embedding": [1.0] + [0.0] * 255,
            "oodScore": 0.05,
        }


class BlockingRunner(MockRunner):
    def __init__(self) -> None:
        super().__init__()
        self.started = threading.Event()
        self.release = threading.Event()

    def infer(self, request: ModernBertRequest) -> Mapping[str, object]:
        self.started.set()
        if not self.release.wait(timeout=2):
            raise RuntimeError("test inference was not released")
        return super().infer(request)


class InferenceContractTests(unittest.TestCase):
    def test_source_byte_bound_cannot_exceed_window_builder_contract(self) -> None:
        with self.assertRaisesRegex(ValueError, "32 KiB"):
            InferenceApplication(
                MockRunner(),
                maximum_model_input_bytes=32 * 1024 + 1,
            )

    def test_validates_hash_taxonomy_and_goal_invariants(self) -> None:
        request = validate_request(request_value())
        self.assertEqual(request.goal_text, "Ship the inference server")
        self.assertEqual(request.goal_version, 3)

        invalid = request_value()
        invalid["goalText"] = "different"
        with self.assertRaisesRegex(
            InferenceProtocolError, "match the immutable modelInput"
        ):
            validate_request(invalid)

        invalid = request_value(False)
        invalid["goalVersion"] = 1
        with self.assertRaisesRegex(InferenceProtocolError, "goalText=null"):
            validate_request(invalid)

        invalid = request_value()
        invalid["inputHash"] = "0" * 64
        with self.assertRaisesRegex(InferenceProtocolError, "does not match"):
            validate_request(invalid)

        invalid = request_value()
        invalid["taxonomyVersion"] = "activity-taxonomy.v2"
        with self.assertRaisesRegex(InferenceProtocolError, "taxonomyVersion"):
            validate_request(invalid)

    def test_temperature_scaling_is_normalized_and_changes_confidence(self) -> None:
        cold = temperature_scaled_probabilities([2.0, 0.0], 0.5)
        warm = temperature_scaled_probabilities([2.0, 0.0], 2.0)
        self.assertAlmostEqual(sum(cold), 1.0)
        self.assertAlmostEqual(sum(warm), 1.0)
        self.assertGreater(cold[0], warm[0])

    def test_application_does_not_echo_model_input_in_errors(self) -> None:
        runner = MockRunner()
        application = InferenceApplication(runner)
        value = request_value()
        secret = "DO-NOT-ECHO-THIS"
        value["modelInput"] = secret
        body = json.dumps(value).encode("utf-8")
        with self.assertRaises(InferenceProtocolError) as captured:
            application.infer(body)
        self.assertNotIn(secret, captured.exception.public_message)


class InferenceHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runner = MockRunner()
        self.server = create_inference_server(
            self.runner,
            port=0,
            authorization_token="fixture-token",
        )
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            kwargs={"poll_interval": 0.01},
            daemon=True,
        )
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def _post(
        self,
        value: object,
        *,
        token: str | None = "fixture-token",
    ) -> tuple[int, dict[str, object]]:
        body = json.dumps(value).encode("utf-8")
        headers = {"content-type": "application/json"}
        if token is not None:
            headers["authorization"] = f"Bearer {token}"
        request = urllib.request.Request(
            f"{self.base_url}{INFERENCE_PATH}",
            data=body,
            method="POST",
            headers=headers,
        )
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            try:
                return error.code, json.loads(error.read())
            finally:
                error.close()

    def test_loopback_endpoint_returns_complete_goal_and_no_goal_outputs(self) -> None:
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        status, response = self._post(request_value())
        self.assertEqual(status, 200)
        self.assertEqual(response["schemaVersion"], "modernbert-inference.v1")
        self.assertEqual(response["windowId"], "window-1")
        self.assertEqual(response["inputHash"], request_value()["inputHash"])
        self.assertEqual(len(response["activityProbabilities"]), 12)
        self.assertEqual(len(response["goalRelevanceProbabilities"]), 4)
        self.assertEqual(len(response["embedding"]), 256)

        status, response = self._post(request_value(False))
        self.assertEqual(status, 200)
        self.assertIsNone(response["goalRelevanceProbabilities"])

    def test_optional_bearer_token_fails_closed_without_logging_content(self) -> None:
        status, response = self._post(request_value(), token=None)
        self.assertEqual(status, 401)
        self.assertEqual(response["error"]["code"], "UNAUTHORIZED")
        self.assertEqual(self.runner.requests, [])

        status, response = self._post(request_value(), token="wrong")
        self.assertEqual(status, 401)
        self.assertEqual(response["error"]["code"], "UNAUTHORIZED")

    def test_concurrency_bound_returns_429_instead_of_queueing_inference(self) -> None:
        runner = BlockingRunner()
        server = create_inference_server(
            runner,
            port=0,
            authorization_token="fixture-token",
            maximum_concurrency=1,
        )
        server_thread = threading.Thread(
            target=server.serve_forever,
            kwargs={"poll_interval": 0.01},
            daemon=True,
        )
        server_thread.start()
        original_url = self.base_url
        self.base_url = f"http://127.0.0.1:{server.server_address[1]}"
        first_result: list[tuple[int, dict[str, object]]] = []
        first_thread = threading.Thread(
            target=lambda: first_result.append(self._post(request_value())),
            daemon=True,
        )
        try:
            first_thread.start()
            self.assertTrue(runner.started.wait(timeout=1))
            status, response = self._post(request_value())
            self.assertEqual(status, 429)
            self.assertEqual(response["error"]["code"], "SERVER_BUSY")
            runner.release.set()
            first_thread.join(timeout=2)
            self.assertEqual(first_result[0][0], 200)
            self.assertEqual(len(runner.requests), 1)
        finally:
            runner.release.set()
            first_thread.join(timeout=2)
            self.base_url = original_url
            server.shutdown()
            server.server_close()
            server_thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()

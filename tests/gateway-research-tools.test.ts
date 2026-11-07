import { describe, expect, test } from "bun:test";
import {
	GATEWAY_TOOL_NAME_RESTORE,
	gatewayResearchTools,
	restoreGatewayToolNames,
} from "../src/agent/mastra-host/cloud-tools/gateway-research-tools";

describe("gateway research tools", () => {
	test("declares exactly the gateway bridge contract names", () => {
		const names = Object.keys(gatewayResearchTools());
		expect(names).toEqual(["zhipu.web_search_prime"]);
	});

	test("restore map covers the Mastra-sanitized underscore form", () => {
		expect(GATEWAY_TOOL_NAME_RESTORE.get("zhipu_web_search_prime")).toBe(
			"zhipu.web_search_prime",
		);
	});

	test("restores tool names in an outbound request body", () => {
		const body = Buffer.from(
			JSON.stringify({
				model: "planning",
				tools: [
					{
						type: "function",
						function: {
							name: "zhipu_web_search_prime",
							description: "search",
							parameters: { type: "object" },
						},
					},
					{
						type: "function",
						function: { name: "unrelated_tool" },
					},
				],
				messages: [{ role: "user", content: "hi" }],
			}),
		);
		const restored = JSON.parse(
			Buffer.from(restoreGatewayToolNames(body)).toString("utf8"),
		);
		expect(restored.tools[0].function.name).toBe("zhipu.web_search_prime");
		expect(restored.tools[1].function.name).toBe("unrelated_tool");
		expect(restored.messages).toEqual([{ role: "user", content: "hi" }]);
	});

	test("leaves non-JSON and unmatched bodies byte-identical", () => {
		const raw = Buffer.from("not-json");
		expect(restoreGatewayToolNames(raw)).toBe(raw);
		const noTools = Buffer.from(JSON.stringify({ messages: [] }));
		expect(restoreGatewayToolNames(noTools)).toBe(noTools);
	});
});

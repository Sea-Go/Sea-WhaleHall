/**
 * 模型工具调用一致性门禁（scripts/model-tool-conformance.ts）
 *
 * 解锁 conversation agent 的 Tool 注册前必须通过本门禁（见
 * docs/CONVERSATION_AGENT_INTEGRATION.md 与 src/agent/mastra-host/cloud-tools/README.md）。
 * 对生产链路（DC 模型网关 → 供应商）实测两轮工具调用：
 *   第一轮：模型必须返回合法 tool_calls（finish_reason=tool_calls、参数可解析且符合 schema）
 *   第二轮：注入工具结果后模型必须收敛为最终文本（finish_reason=stop、无再次调用）
 *
 * 用法：
 *   SEA_CONFORMANCE_BASE_URL=https://127.0.0.1:18443 SEA_CONFORMANCE_BEARER=<token> \
 *     SEA_CONFORMANCE_MODEL=qwen3:1.7b bun scripts/model-tool-conformance.ts
 * Bearer 缺省时用 --insecure-local 直连本机 Ollama（仅用于服务器侧预检）。
 */
import { parseArgs } from "node:util";

interface ToolCallRound {
	finishReason: string | null;
	toolCalls: Array<{ id: string; name: string; arguments: unknown }> | null;
	content: string;
}

const WEATHER_TOOL = {
	type: "function",
	function: {
		name: "get_weather",
		description: "查询城市当前天气",
		parameters: {
			type: "object",
			properties: { city: { type: "string" } },
			required: ["city"],
		},
	},
} as const;

function fail(message: string): never {
	console.error(`[conformance] FAIL: ${message}`);
	process.exit(1);
}

async function roundtrip(
	baseUrl: string,
	headers: Record<string, string>,
	model: string,
	messages: unknown[],
	tools: unknown[],
): Promise<ToolCallRound> {
	// 显式解析并校验网关地址：仅允许 https 或本机回环，阻断参数拼接出的任意外部地址。
	const endpoint = new URL(`${baseUrl.replace(/\/$/, "")}/chat/completions`);
	if (
		endpoint.protocol !== "https:" &&
		endpoint.hostname !== "localhost" &&
		endpoint.hostname !== "127.0.0.1" &&
		endpoint.hostname !== "::1"
	) {
		fail(
			`不允许的网关地址 ${endpoint.protocol}//${endpoint.hostname}（仅允许 https 或本机回环）`,
		);
	}
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({ model, messages, tools, max_tokens: 512 }),
	});
	if (!response.ok) {
		fail(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
	}
	const payload = (await response.json()) as {
		choices?: Array<{
			finish_reason?: string | null;
			message?: {
				content?: string | null;
				tool_calls?: Array<{
					id?: string;
					function?: { name?: string; arguments?: string };
				}>;
			};
		}>;
	};
	const choice = payload.choices?.[0];
	if (!choice?.message) fail("响应缺少 choices[0].message");
	const toolCalls = (choice.message?.tool_calls ?? []).map((call) => {
		if (!call.id || !call.function?.name) {
			fail(`tool_calls 条目缺少 id/function.name：${JSON.stringify(call)}`);
		}
		let args: unknown;
		try {
			args = JSON.parse(call.function?.arguments ?? "{}");
		} catch {
			fail(`工具参数不是合法 JSON：${call.function?.arguments}`);
		}
		return {
			id: call.id as string,
			name: call.function!.name!,
			arguments: args,
		};
	});
	return {
		finishReason: choice.finish_reason ?? null,
		toolCalls: toolCalls.length > 0 ? toolCalls : null,
		content: choice.message?.content ?? "",
	};
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			"insecure-local": { type: "boolean", default: false },
		},
	});
	const baseUrl =
		process.env.SEA_CONFORMANCE_BASE_URL ??
		(values["insecure-local"] ? "http://127.0.0.1:11434/v1" : "");
	if (!baseUrl) fail("缺少 SEA_CONFORMANCE_BASE_URL");
	const bearer = process.env.SEA_CONFORMANCE_BEARER ?? "";
	const model = process.env.SEA_CONFORMANCE_MODEL ?? "qwen3:1.7b";
	const headers: Record<string, string> = bearer
		? { authorization: `Bearer ${bearer}` }
		: {};
	if (!bearer && !values["insecure-local"]) {
		fail("缺少 SEA_CONFORMANCE_BEARER（或显式 --insecure-local）");
	}
	console.log(`[conformance] base=${baseUrl} model=${model}`);

	// 第一轮：必须发起工具调用。
	const first = await roundtrip(
		baseUrl,
		headers,
		model,
		[{ role: "user", content: "用工具查一下北京天气" }],
		[WEATHER_TOOL],
	);
	if (first.finishReason !== "tool_calls" || !first.toolCalls) {
		fail(
			`第一轮未发起工具调用（finish=${first.finishReason}，content=${first.content.slice(0, 120)}）`,
		);
	}
	const call =
		first.toolCalls.find((c) => c.name === "get_weather") ?? first.toolCalls[0];
	if (!call) fail("tool_calls 列表为空");
	const args = call.arguments as { city?: unknown };
	if (typeof args.city !== "string" || args.city.length === 0) {
		fail(`工具参数不符合 schema：${JSON.stringify(call.arguments)}`);
	}
	console.log(
		`[conformance] round1 ok: ${call.name}(${JSON.stringify(call.arguments)})`,
	);

	// 第二轮：注入工具结果后必须收敛为文本答案。
	const second = await roundtrip(
		baseUrl,
		headers,
		model,
		[
			{ role: "user", content: "用工具查一下北京天气" },
			{
				role: "assistant",
				content: "",
				tool_calls: [
					{
						id: call.id,
						type: "function",
						function: {
							name: call.name,
							arguments: JSON.stringify(call.arguments),
						},
					},
				],
			},
			{
				role: "tool",
				tool_call_id: call.id,
				content: JSON.stringify({ temp_c: 18, cond: "多云" }),
			},
		],
		[WEATHER_TOOL],
	);
	if (second.finishReason !== "stop" || second.toolCalls) {
		fail(
			`第二轮未收敛（finish=${second.finishReason}，toolCalls=${JSON.stringify(second.toolCalls)}）`,
		);
	}
	if (second.content.trim().length === 0) fail("第二轮收敛但答案为空");
	console.log(
		`[conformance] round2 ok: ${second.content.trim().slice(0, 120)}`,
	);
	console.log("[conformance] PASS：生产模型通过工具调用一致性门禁");
}

await main();

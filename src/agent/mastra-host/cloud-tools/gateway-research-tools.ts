import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * 网关服务端 MCP 工具环（Sea-DataCenter internal/llmgateway/mcpbridge_loop.go）
 * 的名字契约：模型对 "zhipu.<mcp tool>" 发起的 tool_calls 由 DC 网关在服务端
 * 执行并回填续生成——Mastra 永远不会在本地收到这些调用。这里的 execute 只是
 * 网关桥不可用（密钥缺失降级、直连供应商等）时的兜底，保证模型能继续收敛。
 */
export const GATEWAY_RESEARCH_TOOL_NAMES = ["zhipu.web_search_prime"] as const;

/**
 * Mastra 在工具注册层把工具名规范成 [a-zA-Z0-9_-]（点→下划线），而网关桥
 * 契约按 "<prefix>.<tool>" 点分匹配。此表把出站请求里的规范化名还原成契约
 * 名；工具环在网关服务端闭环，回程不含这些名字，无需反向映射。
 */
export const GATEWAY_TOOL_NAME_RESTORE: ReadonlyMap<string, string> = new Map(
	GATEWAY_RESEARCH_TOOL_NAMES.map((name) => [
		name.replace(/\./gu, "_"),
		name,
	]),
);

/** 就地还原请求体 tools 数组里的桥接工具名；非 JSON 或无匹配时原样返回。 */
export function restoreGatewayToolNames(body: Uint8Array): Uint8Array {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(body).toString("utf8"));
	} catch {
		return body;
	}
	if (typeof parsed !== "object" || parsed === null) return body;
	const payload = parsed as { tools?: unknown };
	if (!Array.isArray(payload.tools)) return body;
	let changed = false;
	const tools = payload.tools.map((tool) => {
		if (typeof tool !== "object" || tool === null) return tool;
		const entry = tool as { function?: { name?: unknown } };
		const name = entry.function?.name;
		if (typeof name !== "string") return tool;
		const restored = GATEWAY_TOOL_NAME_RESTORE.get(name);
		if (restored === undefined) return tool;
		changed = true;
		return {
			...entry,
			function: { ...entry.function, name: restored },
		};
	});
	if (!changed) return body;
	return Buffer.from(JSON.stringify({ ...payload, tools }), "utf8");
}

const FALLBACK_RESULT = {
	content:
		"网关搜索当前不可用：请基于已有信息完成分析，并在 assumptions 中注明相应事实未经联网核实。",
};

const gatewaySearchInput = z
	.object({
		search_query: z.string().trim().min(1).max(160),
		search_domain_filter: z.string().trim().max(200).optional(),
	})
	.strict();

/** 计划调研可用的网关桥接工具集。键名即发给供应商的工具名，不可改。 */
export function gatewayResearchTools(): Record<
	(string & {}) | (typeof GATEWAY_RESEARCH_TOOL_NAMES)[number],
	ReturnType<typeof createTool>
> {
	return {
		"zhipu.web_search_prime": createTool({
			id: "zhipu.web_search_prime",
			description:
				"全网搜索，返回网页标题、链接、摘要与引用。用于计划前调研：需要联网确认的事实（做法/时长/截止日期/开放时间/费用等）。search_query 建议不超过 70 字；结果要汇入 rationaleSummary 与 estimateBasis，不得虚构需要联网确认的事实。",
			inputSchema: gatewaySearchInput,
			execute: async () => FALLBACK_RESULT,
		}),
	};
}

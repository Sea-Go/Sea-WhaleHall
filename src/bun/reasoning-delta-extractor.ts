/**
 * 从流式 SSE 字节中增量解析 reasoning_content 思考增量。
 * 网关的 MCP 工具环把中间轮思考与 [调研] 进度都以协议内合法的
 * reasoning 增量帧下发——这里逐帧抽取文本，供客户端实时展示。
 */
export class ReasoningDeltaExtractor {
	private buffer = "";

	/** 喂入一段响应字节，返回这段里解析出的思考文本增量（可能为空）。 */
	feed(chunk: Uint8Array): string {
		this.buffer += Buffer.from(chunk).toString("utf8");
		// 非流式 JSON 响应可能整段无换行：钳制缓冲防跨请求无限增长。
		if (this.buffer.length > 1_048_576) {
			this.buffer = "";
			return "";
		}
		let delta = "";
		for (;;) {
			const lineEnd = this.buffer.indexOf("\n");
			if (lineEnd < 0) break;
			const line = this.buffer.slice(0, lineEnd).trim();
			this.buffer = this.buffer.slice(lineEnd + 1);
			if (!line.startsWith("data:")) continue;
			const payload = line.slice("data:".length).trim();
			if (payload === "" || payload === "[DONE]") continue;
			delta += extractReasoningText(payload);
		}
		return delta;
	}
}

function extractReasoningText(payload: string): string {
	try {
		const parsed = JSON.parse(payload) as {
			choices?: Array<{
				delta?: { reasoning_content?: unknown };
			}>;
		};
		const value = parsed.choices?.[0]?.delta?.reasoning_content;
		return typeof value === "string" ? value : "";
	} catch {
		return "";
	}
}

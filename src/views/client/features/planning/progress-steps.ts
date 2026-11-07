import type { PlanningProgressStep } from "../../../../shared/planning";

/**
 * 把网关下发的 reasoning 增量流解析成 Claude Code 式的结构化步骤时间线：
 * - 思考块（thinking）：两次工具调用之间的推理文本，默认折叠。
 * - 工具块（tool）：`[调研] 工具 参数` 开一行 ⏺ 调用行，`[调研] 完成（N 字）`
 *   归位成 ⎿ 结果行；状态点 灰=执行中 → 绿=完成 / 红=失败。
 *
 * 网关的进度帧协议见 Sea-DataCenter mcpbridge_loop.go 的
 * executeBridgedToolsWithProgress——[调研] 前缀即块边界标记。
 */
export class PlanningProgressParser {
	readonly steps: PlanningProgressStep[] = [];
	private thinkingText = "";
	private thinkingStartedAtMs: number | null = null;
	private readonly startedAtMs = Date.now();

	/** 喂入一段思考增量，返回需要下发的步骤快照（引用同一数组，浅拷贝发送）。 */
	feed(delta: string): readonly PlanningProgressStep[] {
		if (delta === "") return this.snapshot();
		for (const line of delta.split("\n")) {
			this.acceptLine(line);
		}
		return this.snapshot();
	}

	private acceptLine(line: string): void {
		const trimmed = line.trim();
		if (trimmed === "") return;
		// 工具调用行：[调研] tool key=value …
		const call = /^\[调研\]\s+(\S+)\s*(.*)$/u.exec(trimmed);
		if (call) {
			const tool = call[1] ?? "tool";
			const args = call[2] ?? "";
			if (args !== "" && !args.startsWith("完成") && !args.startsWith("失败")) {
				this.sealThinking();
				this.steps.push({
					kind: "tool",
					tool,
					args: args.slice(0, 200),
					status: "running",
					startedAtMs: this.nowOffsetMs(),
				});
				return;
			}
			// 结果行：完成（N 字结果） / 失败（…）——归位到最近一个同工具的执行中块。
			const done = /^完成（(\d+)\s*字结果）$/u.exec(args);
			if (done) {
				const target = this.lastRunningTool(this.steps, tool);
				if (target) {
					target.status = "done";
					target.result = `${done[1] ?? "?"} 字结果`;
				}
				return;
			}
			if (args.startsWith("失败") || args.startsWith("Error")) {
				const target = this.lastRunningTool(this.steps, tool);
				if (target) {
					target.status = "failed";
					target.result = args.slice(0, 120);
				}
				return;
			}
			// 其余 [调研] 行（如失败说明）并入思考。
			this.appendThinking(trimmed);
			return;
		}
		this.appendThinking(line);
	}

	private appendThinking(line: string): void {
		if (this.thinkingStartedAtMs === null)
			this.thinkingStartedAtMs = this.nowOffsetMs();
		this.thinkingText += (this.thinkingText === "" ? "" : "\n") + line;
	}

	private sealThinking(): void {
		if (this.thinkingText === "") return;
		this.steps.push({
			kind: "thinking",
			text: this.thinkingText,
			startedAtMs: this.thinkingStartedAtMs ?? this.nowOffsetMs(),
		});
		this.thinkingText = "";
		this.thinkingStartedAtMs = null;
	}

	private lastRunningTool(
		steps: PlanningProgressStep[],
		tool: string,
	): (PlanningProgressStep & { kind: "tool" }) | undefined {
		for (let index = steps.length - 1; index >= 0; index -= 1) {
			const step: PlanningProgressStep | undefined = steps[index];
			if (
				step !== undefined &&
				step.kind === "tool" &&
				step.tool === tool &&
				step.status === "running"
			) {
				return step;
			}
		}
		return undefined;
	}

	private snapshot(): readonly PlanningProgressStep[] {
		const steps = [...this.steps];
		if (this.thinkingText !== "") {
			steps.push({
				kind: "thinking",
				text: this.thinkingText,
				startedAtMs: this.thinkingStartedAtMs ?? this.nowOffsetMs(),
			});
		}
		return steps;
	}

	private nowOffsetMs(): number {
		return Date.now() - this.startedAtMs;
	}
}

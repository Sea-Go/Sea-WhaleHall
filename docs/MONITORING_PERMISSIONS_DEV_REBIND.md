# 监测授权在 dev 重建后失效（TCC 重签名绑定）

## 症状

`electrobun dev` 重建并重启应用后，日历侧栏"观察中"卡片持续显示
"还有 N 项系统权限待完成"，尽管"系统设置 → 隐私与安全性 →
辅助功能 / 屏幕录制"里 WhaleHall 相关条目的开关都是打开状态。

后台任务（观察者采集、时间线归因、计划任务的"已投入"进度统计）
因此不产生任何数据：`accessibility.sqlite3` 的
`accessibility_snapshots` 表计数为 0，计划观测证据
（`observationEvidence`）不累积。

## 根因

macOS TCC 授权条目按**代码签名身份**绑定。每次 dev 重建都会重签
WhaleHall Observer 与主应用（构建日志可见 "replacing existing
signature"），旧授权条目绑定的签名随即失效——开关状态保留，
但当前运行的二进制已不匹配该身份，系统按未授权处理。

打包版（canary/stable）签名稳定，不受影响；这是 dev 工作流已知成本。

## 修复步骤

1. 系统设置 → 隐私与安全性 → **屏幕录制**（录屏与系统录音）面板：逐条选中
   WhaleHall 相关旧条目——包括 `WhaleHall Observer`、`WhaleHall-dev`，以及
   通用名称 `launcher`（WhaleHall 启动器二进制的残留条目）——点列表下方
   **"−"（减号）删除**；
2. 重启开发应用（按[桌面运行时](desktop-runtime.md)的启动方式与
   环境变量）。2026-11-08 实证：删除旧条目并重启后，当前签名身份的
   `screenRecording` 检查直接恢复 `granted`，无需在应用内执行一次性授权
   请求（`setupAttempted` 保持 `false`），面板也可能不再出现新条目；
   若出现新条目，打开其开关即可；
3. 辅助功能条目绑定当前签名时**不要删除**（删除会丢失已有授权）；
   辅助功能授权生效通常也需要应用重启。

注意：屏幕录制面板的开关显示状态存在刷新抖动（同一面板先后截图可能
在开/关间翻转），不代表真实授权状态；以
`permissions.v2.json` 的取值和应用侧"观察中"卡片为准。

## 诊断

- 权限状态落盘：
  `~/Library/Application Support/com.seago.whalehall/dev/local/monitoring/permissions.v2.json`，
  各项取值 `granted | unknown | notDetermined | denied | unavailable`。
  判定源：辅助功能与屏幕录制两项阻断就绪
  （[monitoring domain](../src/views/client/features/monitoring/domain.ts)，
  inputMonitoring 与 browserAutomation 不阻断）。
- 采集是否运行：观测事件是否在流动——
  `~/Library/Application Support/com.seago.whalehall/dev/local/observation-journal.sqlite3`
  的 `semantic_events` 表计数在几十秒间隔内增长即采集正常（事件来源
  `ax.observer-*`）。`dev/local/accessibility.sqlite3` 的
  `accessibility_snapshots` 表是历史遗留存储，长期保持 0，**不作为**
  健康信号。
- 授权检查只读状态，从不弹系统提示
  （[monitoring service 约定](../src/views/client/features/monitoring/monitoring-service.ts)），
  修复必须走系统设置手动切换。
- 高负载时系统设置自身可能启动即被系统回收，等负载回落再操作。

## 任务进度的依赖

Dynamic Planning 的任务"已投入"进度来自观测证据
（`observationEvidence` 按 taskId 聚合的 `relevantMinutes`），
而观测证据依赖上述授权。授权未完成时计划卡任务清单正常渲染，
但不显示"已投入"文案（不伪造进度），排序回退为按最近排期升序。

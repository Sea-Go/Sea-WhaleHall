# RTW summary 产品客户端边界

`RTWProductSearchClient` 只属于 Bun。它按 RTW `api/knowledge.api` 发起已认证的产品 POST/GET：POST 正文固定为 `module_id/query/depth/intelligence/idempotency_key`，GET 使用 RTW 返回的 `search_id`。本组件不签发用户 SubjectRef、发布快照、search/answer ID，不向 WebView 或 Mastra Sidecar交付 bearer。

调用方必须给出**RTW认可的本人产品会话**提供者。`RTWProductSessionProvider`按每次请求取当前短期会话，并在网络回执后再次核对会话代次；换号中的旧回执返回`SESSION_CHANGED`而不交给新账号。当前WhaleHall只登录DataCenter UUID账号，尚无RTW UID/JWT关联提供端，本客户端未在正式Bun进程注册。产品账号方案与联调门禁见Sea-Docs`H01双账号关联与桌面产品会话交接.md`。

## 云端已接纳答案历史

`RTWCloudHistoryClient`复用同一提供者，按 RTW 逻辑`session_id`的`after_ordinal`升序读取已接纳答案，并逐条读取当前引用状态。它核对冻结 turn 的 answer/search/session/subject/evidence ID、固定发布版、来源键、revision、quote_hash，且用SHA256重算冻结quote；仅当前引用`available`且各字段吻合时输出至多240个Unicode码点的摘录。引用不可用、断网或字段不符时清除/不投影旧摘录；原始turn_json、EvidencePack及bearer不进入WebView。当前 Bun Typed RPC 明确返回`disabled`，因为产品会话提供者与本地会话到 RTW 逻辑会话的映射尚未交接；主窗口的云端页也显示此状态，不使用本地 ConversationThread ID 猜测。

真 RTW/UserCenter 双阶段交接可运行`RTW_CLOUD_HISTORY_READY=/path/to/0600-ready.json bun tests/rtw-cloud-history-handoff.ts`。2026-09-15 的同现场父验收`/private/tmp/sea-whalehall-history-parent-20260915/report.json`退出0：真实UserCenter/Knowledge HTTP及Go race/vet/mod verify通过；Bun按`after_ordinal`读取两笔答案，stage1两笔引用`available`且摘录可见，知识源撤回后stage2两笔`unavailable`且摘录不可见，另一真实账号读取0笔，renderer输出没有原始quote字段。此为隔离交接验证，尚未建立正式 WhaleHall 产品登录、主窗口真实账号联验或生产可见能力。

WhaleHall 局部`bun test tests/cloud-history-client.test.tsx tests/rtw-cloud-history-client.test.ts`为11 pass，包含页隐藏→来源撤回→返回云端首帧无旧摘录；`bun run typecheck`和`bun run build:views`退出0。首次隔离`bun run check`因该worktree缺固定邻接`Sea-DataCenter/contracts/v1`而在既有 DataCenter 合同测试加载时报错；临时建立仅供测试读取的邻接符号链接、保留原断言后复跑`bun run check`为1435 pass/5 skip/0 fail（含Rust检查），随后移除链接并确认不存在。静态DOM只验状态与文案，未进行真实Electrobun窗口1440×900、1180×720视觉验收。

返回值区分已接纳`succeeded/insufficient`、`in_flight`及`retryable_failure`。202应按固定SearchID GET，503/可重试状态应以原正文和原幂等键POST；409是异文冲突，调用方停止旧键。取消只终止本机等待，不假装撤销RTW已提交操作；恢复时以同键或固定ID查RTW权威记录。当前组件不做自动重试、不持久化未决操作、不实现Tools证据接口或完整SSE。客户端校验响应状态/核心ID/引用quote hash，RTW PG仍是引用和答案的权威接纳者。

局部验收：`bun test tests/rtw-product-search-client.test.ts`，随后`bun run typecheck`、`bunx biome check src/bun/clients/product/rtw-product-search-client.ts tests/rtw-product-search-client.test.ts`及`bun run check`。真实RTW JWT提供端、WhaleHall总RPC装配、桌宠可见卡片、RTW/BTW/DC全链和Collector均未在此包验收。

# SubjectRef v2：WhaleHall Bun 云端答案历史双读验收

本切片从 WhaleHall 集成提交 `1d53437ba3a6de6c90e586b7aea5f856337b333a` 的独立工作树开始，只修改 Bun 的 RTW 历史响应适配、相邻测试及本记录。RTW、DataCenter 和 Docs 为只读输入；当前 RTW 产品端仍只生产 v1 历史，本切片先用固定 fixture 准备 v2 消费者，不宣布 v2 生产切换或数据库迁移完成。

## 双读合同

| 外层 `subject` | 不可变 `turn_json.Request.Subject` | 结果 |
| --- | --- | --- |
| v1 `{authority_id:"rtw.identity",tenant_id:"platform",subject_id:<UID>}` | v1 | 接受旧历史 |
| v2 `{issuer:"rtw.identity",subject_id:<UID>}` | v2 | 接受新格式 fixture |
| v2 | 原始 v1 | 接受只读 v2 外层投影，不改旧 turn |
| v1 | v2 | 拒绝倒置投影 |

两版主体先统一成 `{issuer:"rtw.identity",subjectId:<规范十进制正 int64 字符串>}` 再比较。UID 不经 JavaScript `number` 转换，支持 `9007199254740993` 和 `9223372036854775807`，拒绝超范围、前导零、负值和小数。v1 只允许固定 `platform` 兼容槽；v2 不接受 `authority_id`、`tenant_id`、`realm` 或其他额外主体键。外层与 turn 不同人、同页混入不同 UID、AnswerID/SearchID/SessionID 不一致均在读取当前引用状态前拒绝。

HTTP JSON、内嵌 turn JSON 的每层对象在 `JSON.parse` 前检测重复键，包括 Unicode 转义后同名的键。外层响应、分页行、实时引用状态、turn 根、`Request`、`result` 和来源 `key` 都使用严格 Zod 形状；历史 Search/Snapshot/EvidencePack/Evidence 的可扩展领域元数据按既有 v1 内容读取，但它们的身份、引用键、冻结 quote hash 和请求/证据包快照仍逐项核验。冻结证据 ID 或引用 ID 重复、引用缺失、quote hash 异文、请求与证据包版本不一致会拒绝整条历史。实时引用因撤回或版本失配时仍只返回 `unavailable`，不回放冻结摘录；实时响应若带未知字段则拒绝。

Bun 继续使用现有 RTW `ProductSessionProvider` 的 access token、会话 ID 和 generation 限制，并在每次远端读取后复核同一 generation。它不从 DataCenter UUID 推测 RTW UID，不让 WebView 传主体，也不把 bearer、原始 SubjectRef、`turn_json` 或完整 quote 放入共享 Typed RPC 结果。WebView 只得到现有 `CloudAcceptedAnswer` 的问题、答案、引用状态及可用时限长的已核摘录，旧 API 形状保持不变。

## 本地验收与交接

定向 `bun test tests/rtw-cloud-history-client.test.ts tests/rtw-history-json.test.ts` 为 14 通过、0 失败，覆盖上述三种正向组合、两种高位 UID、错误版本/主体/跨用户/重复键/quote hash 和会话 generation 反例。`bun run typecheck`、受影响五文件 `bunx biome check`、`bun run build:views` 均退出 0。完整 Bun 测试在新 worktree 临时提供 DataCenter 相邻只读路径后为 1443 通过、5 跳过、0 失败；测试结束已移除该路径。此前首次统一 `bun run check` 因隔离工作树没有测试假定的相邻 DataCenter 目录及一次 native JSONL probe 失败；native probe 定向重跑通过。最终统一 `bun run check` 使用缓存好的 Rust 工件、`CARGO_INCREMENTAL=0` 与无调试 Cargo profile，退出 0：Rust fmt/Clippy/测试、TypeScript 与完整 Bun 均通过。最终 check 日志在本机临时证据目录，SHA-256 为 `b3db853cf41b07dba98eb709b2c6ad82477628aade01c521e31bccb4168557b9`；临时 DataCenter 只读邻接链接在执行后已删除。

**验收状态：`LOCAL_VERIFIED`，仅限 Bun v1/v2/mixed fixture 与现有 v1 回归。** 当前 RTW 未发布 v2 历史响应，也没有真实 v2 用户或生产链路。RTW API 不返回已存储的 `turn_hash`，所以 Bun 不能声称验证了数据库中的原始 turn hash；其验证范围是响应形状、主体/业务 ID、冻结 quote hash、实时引用回执与产品会话限制。WebView 视觉布局未修改，本切片没有 Electrobun 窗口可视验收。

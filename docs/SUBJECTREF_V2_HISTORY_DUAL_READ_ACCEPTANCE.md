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

HTTP JSON、内嵌 turn JSON 的每层对象在 `JSON.parse` 前检测重复键，包括 Unicode 转义后同名的键。外层响应、分页行、实时引用状态、turn 根、`Request`、`result` 和来源 `key` 都使用严格 Zod 形状；历史 Search/Snapshot/EvidencePack/Evidence 的可扩展领域元数据按既有 v1 内容读取，不投影额外元数据。快照的 module/release/generation/发布修订、三路原始索引对象和有效修订列表全部逐值核对；证据包的 SearchID 与 `complete|partial|empty` 终态必须与答案一致。冻结证据 ID 或引用 ID 重复、引用缺失、quote hash 异文、请求与证据包版本不一致会拒绝整条历史。RTW 实时引用的已知 `original`（key/SHA）与 `locator`（段落和原始/规范位置）不属于未知字段，严格解码后逐项核冻结证据；撤回或定位/原对象版本失配时只返回 `unavailable`，不回放冻结摘录；实时响应真正带未知字段时拒绝。

Bun 继续使用现有 RTW `ProductSessionProvider` 的 access token、会话 ID 和 generation 限制，并在每次远端读取后复核同一 generation。它不从 DataCenter UUID 推测 RTW UID，不让 WebView 传主体，也不把 bearer、原始 SubjectRef、`turn_json` 或完整 quote 放入共享 Typed RPC 结果。WebView 只得到现有 `CloudAcceptedAnswer` 的问题、答案、引用状态及可用时限长的已核摘录，旧 API 形状保持不变。

## 本地验收与交接

初版 `6d5a180` 的定向14项、最终 `bun run check`（1443通过/5跳过、Rust fmt/Clippy/测试/TypeScript/Bun）及其日志 SHA `b3db853cf41b07dba98eb709b2c6ad82477628aade01c521e31bccb4168557b9` 是**修复前基线**；静态审查发现初版把RTW真实引用 `original/locator` 错判未知、缺证据包与完整快照核对，该基线不能证明实际历史可读。此前第一次统一门禁的DC相邻路径与native JSONL故障均有单独失败轮，后者定向重跑通过，不抹成成功。

修复 `8ebd1f8` 后定向两文件为15通过、95项断言、0失败，`bun run typecheck`、改动源码/测试 `bunx biome check`、diff检查通过；临时链接到**当前干净DC开发集成**只读合同的完整 `bun test` 为1444通过/5跳过/0失败、159文件，日志 SHA `63d31fcd3b315599c0571375607c28e4169c433e411121fad9f3bbf9a9779bf7`，执行后链接已移除。Rust/视图文件本修复未变，因此没有把修复前的统一`check`伪称修复后重新跑过。RTW 当前开发集成 + 修复后 Bun 又运行 `python3 service/knowledge/scripts/whalehall_history_acceptance.py`，真实隔离User Center/Knowledge HTTP的两阶段报告 SHA `d3cbf61fb0832edf9a83a09143682f1866fda98d91771a1125a00e566b6636a0`：两条历史引用可用时已核摘录均可见，撤回后均不可见，另一账户两阶段各0条，完整quote字段未暴露；RTW `TestRealHTTPKnowledgeWorkflowWithUserCenter` 15.98秒PASS，父源日志 SHA `a38c81ed3627ace5e023fe23b3e3264ec344c37f1d686281f9c24021b73abae2`。隔离PG与子进程结束，报告只保留本机，不含JWT/口令/DSN。

另在代码不变的情况下，`78e973b` 加入**证据不足历史**的 v1外层/v1 turn 与 v2外层/原v1 turn 两个本地完整旧快照夹具，确认answer为空、引用为空而不制造摘录；两文件专项变为16通过、101断言，Biome/diff通过。前述完整Bun1444通过的固定报告在这一**测试补充之前**，并不包含新用例；实际旧`insufficient`答案尚未用真RTW双阶段脚本验其快照形状。

**验收状态：本地 v2/mixed `LOCAL_VERIFIED`、真实 v1 RTW→Bun 子链 L3 通过，整体仍 `PARTIAL`。** 当前 RTW 未生产 v2 历史响应，也没有真实 v2 用户或生产链路；真实双阶段只证明两条成功答案的旧版签发与新消费者兼容。RTW API 不返回已存储的 `turn_hash`，所以 Bun 不能声称验证了数据库中的原始 turn hash；其验证范围是响应形状、主体/业务 ID、冻结 quote hash、实时引用回执与产品会话限制。WebView 视觉布局未修改，本切片没有 Electrobun 窗口可视验收，DC账户UUID与RTW UID仍未绑定。

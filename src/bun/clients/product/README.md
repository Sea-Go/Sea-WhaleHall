# RTW summary 产品客户端边界

`RTWProductSearchClient` 只属于 Bun。它按 RTW `api/knowledge.api` 发起已认证的产品 POST/GET：POST 正文固定为 `module_id/query/depth/intelligence/idempotency_key`，GET 使用 RTW 返回的 `search_id`。本组件不签发用户 SubjectRef、发布快照、search/answer ID，不向 WebView 或 Mastra Sidecar交付 bearer。

调用方必须给出**RTW认可的本人产品会话**提供者。`RTWProductSessionProvider`按每次请求取当前短期会话，并在网络回执后再次核对会话代次；换号中的旧回执返回`SESSION_CHANGED`而不交给新账号。当前WhaleHall只登录DataCenter UUID账号，尚无RTW UID/JWT关联提供端，本客户端未在正式Bun进程注册。产品账号方案与联调门禁见Sea-Docs`H01双账号关联与桌面产品会话交接.md`。

返回值区分已接纳`succeeded/insufficient`、`in_flight`及`retryable_failure`。202应按固定SearchID GET，503/可重试状态应以原正文和原幂等键POST；409是异文冲突，调用方停止旧键。取消只终止本机等待，不假装撤销RTW已提交操作；恢复时以同键或固定ID查RTW权威记录。当前组件不做自动重试、不持久化未决操作、不实现Tools证据接口或完整SSE。客户端校验响应状态/核心ID/引用quote hash，RTW PG仍是引用和答案的权威接纳者。

局部验收：`bun test tests/rtw-product-search-client.test.ts`，随后`bun run typecheck`、`bunx biome check src/bun/clients/product/rtw-product-search-client.ts tests/rtw-product-search-client.test.ts`及`bun run check`。真实RTW JWT提供端、WhaleHall总RPC装配、桌宠可见卡片、RTW/BTW/DC全链和Collector均未在此包验收。

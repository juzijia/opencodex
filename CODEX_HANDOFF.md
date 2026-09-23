# Codex Handoff

## 1. 当前目标

- 在本地完成 PR #5554 的 Qoder MCP bridge 整改，覆盖 `.tmp/PR-5554-AUDIT.md` 确认的 13 项问题。
- 只保留必要的工具契约提示词，避免把工具名称语法错误误当成提示词问题。
- 用户明确禁止创建、更新或推送 PR；后续工作仍限本地，除非用户另行授权。

## 2. 当前真实状态

- Git 根目录：`C:/Users/orange/Documents/ChatGPT/OpenCodex/pr-5554-audit`。
- 分支：`codex/qoder-5554-remediation`；HEAD：`e47814bf76fbb0469015dcd88e85ae3c70a8028b`（PR #5554 当时的 HEAD）。
- 工作树有 14 个已跟踪文件的未提交修改；没有本轮 commit、push 或 PR 操作。`CODEX_HANDOFF.md` 是本次交接新增文件。
- 本地修复覆盖工具名称匹配、请求内 JSON Schema 编译/校验、临时 prompt 清理、side-channel capture/init/取消/usage、历史截断估算、scaffold 标签边界、超限 helper 错误记录及用户可见 CodeBuddy 文案。
- 真实 Qoder 服务端到端行为和 PR 当前远端状态在整改后均未复核，状态为 `unknown`。

## 3. 当前架构 / 关键决定

- Qoder 的 MCP 工具由隔离的 capture helper 广告，host 负责授权和执行；side-channel 每次 invocation 最多接受一个工具调用。`src/adapters/coding-agent/turn.ts` 必须同时验证原生 tool-use ID、capture 记录、init 和目录身份后才发出调用。
- Schema 在 `src/adapters/qoder/tool-bridge.ts` 按请求和工具编译，明确拒绝异步及不支持的方言；内部 `CODEBUDDY_*` 等标识不做全量 rename。
- 带工具的请求保留极短工具契约提示词；无工具路径保留原有 `--max-turns 1`。调用方 system/developer 内容继续经私有临时文件传输，结束后清理。
- 对无法等到完整 result 的 capture leg，保留已观察 token 数并标记 `estimated`；不把部分 usage 当完整权威账单。
- 审计报告的条件性问题（仅完整 assistant 帧的 tool_use、host `store:false` 续接落盘、pricing overlay 拆分）未在本轮扩大修改，需凭真实 fixture/独立任务裁决。

## 4. 修改状态

- 生产代码：`package.json`、`bun.lock`、`src/adapters/coding-agent/{protocol,turn}.ts`、`src/adapters/qoder/{adapter,mcp-server,scaffold-guard,tool-bridge}.ts`。
- 回归测试：`tests/providers/qoder-{adapter,estimated-usage,mcp-server,scaffold-guard,tool-bridge-turn,tool-bridge}.test.ts`。
- 以上均未提交、未 push；`git diff --stat` 在交接前为 14 files，+928/−94。不要将这一快照误读为已合入 PR。

## 5. 验证状态

- 已自动验证：WSL Ubuntu/Bun 1.4.0 定向七个 provider 测试文件，151 pass / 0 fail；`bun x tsc --noEmit`、`bun run privacy:scan`、`bun run structure:check`、`git diff --check` 通过。
- 定向测试入口：`wsl -d Ubuntu-24.04 -- sh .tmp/run-focused.sh`；最近结果在 `.tmp/current-focused.log`。
- 广域验证未通过：默认 `bun run test:changed` 因此隔离检出没有 `dev` 比较 ref 而退出；直接 `bun scripts/test.ts --changed=HEAD` 选中 1086/1509 个测试文件，在 `/mnt/c` 上大量测试报 `atomic temporary file permissions are not owner-only`，运行被停止。日志在 `.tmp/test-changed-head.log`；不可据此宣称全 CI 绿或业务回归已确认。
- 未验证：真实 Qoder CLI/API 端到端工具发现、调用与续接；PR 远端 CI/冲突；人工验收。
- V1 子代理曾优先尝试 Qoder，初次因额度耗尽转用 DeepSeek；额度恢复后再次启动 Qoder 只读复核，但未返回结论，不能算独立审查通过。

## 6. 已知坑 / 禁止事项

- Windows Bun 测试 preload 会拒绝 runtime junction/reparse；不要绕过安全检查。
- WSL 在 `/mnt/c` 上无法满足部分测试的 owner-only 文件权限语义；广域测试应移到原生 Linux 文件系统。
- `test:changed` 默认绑定 `dev`，此检出没有该 ref；可用 `bun scripts/test.ts --changed=HEAD` 对未提交 diff 选测，但选集很大。
- 不做全量命名/抽 util/风格重构；不凭提示词修工具名称或 schema 校验缺陷。
- 不创建、更新、推送 PR，也不向远端发送测试凭据或代码。

## 7. 未解决问题

- 广域 changed 测试未在支持 owner-only 权限的文件系统完成。
- 真实 Qoder CLI 1.1.57 的 raw init、capture、usage 顺序和仅完整 assistant 帧兼容性尚无端到端 fixture。
- host `store:false` 续接落盘策略和 pricing overlay 归属仍是审计中的独立边界问题；本轮未修改。
- 本地整改尚未经过完成的独立代码审查，且未提交。

## 8. 下一步唯一任务

在 WSL 的**原生 Linux 文件系统**建立隔离检出并带入当前未提交 diff，运行 `bun scripts/test.ts --changed=HEAD`；记录完整通过/失败结果，先区分真实代码回归与 `/mnt/c` 文件权限假失败。不要改变当前 Windows 工作树或远端状态。

## 9. 新会话启动指令

这是 PR #5554 的本地整改续接。先读当前 AGENTS.md 指令和此文件，核对 Git HEAD/status，以磁盘为准；然后只执行第 8 节的下一步任务，不创建或更新 PR。

## 10. Handoff Snapshot

- Repo：`C:/Users/orange/Documents/ChatGPT/OpenCodex/pr-5554-audit`
- Branch：`codex/qoder-5554-remediation`
- HEAD：`e47814bf76fbb0469015dcd88e85ae3c70a8028b`
- PR #5554 整改仅在本地；无本轮 commit/push/PR 更新
- 14 个已跟踪文件未提交：8 个生产/依赖，6 个测试
- 审计清单：`.tmp/PR-5554-AUDIT.md`，13 项确认问题
- 工具匹配复用 `namespacedToolName`
- Schema：请求内 AJV，显式 draft-07/2019-09/2020-12，同 `$id` 隔离
- Side-channel：init + native ID + bounded capture 校验，一次一调用
- Usage：部分值保留并标 `estimated`
- Prompt：保留最小工具契约；无工具 `--max-turns 1`
- 定向测试：151 pass / 0 fail（`.tmp/run-focused.sh`）
- TypeScript、privacy、structure、diff check：通过
- changed 测试：`/mnt/c` owner-only 权限失败；未全绿
- 真实 Qoder E2E、远端 CI/冲突：`unknown`
- 下一步：原生 Linux FS 完整运行 `--changed=HEAD`

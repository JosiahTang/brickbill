# T37 实现与验收记录

日期：2026-10-21。按 T37.1 → T37.6 执行。保留工作区已有 T30—T36 及此前未提交改动；没有提交或推送 Git。

## 逐项状态

| 任务 | 编码状态 | 验证/环境状态 |
| --- | --- | --- |
| T37.1 子进程与辅助容器清理 | 已完成 | 超时后发送 SIGTERM，宽限期后发送 SIGKILL；即使没有 `close` 事件也有界失败。备份/恢复辅助容器使用本次 run id 名称和标签，清理前核对标签。本地定向回归通过；Docker 资源清理尚未在真实 daemon 上演练。 |
| T37.2 部署证据兼容校验 | 已完成 | 显式版本先于 acceptance v1 的历史兼容分支校验；未知版本失败，显式 v3 继续校验依赖摘要。未标部署证据版本的历史 v1 仍按既有规则读取。没有改变证据格式。 |
| T37.3 PDF 容器烟测 | 已完成 | GitHub Docker 作业启用 `BRICKBILL_SMOKE_EXPECT_PDF=1`，沿用现有 smoke 对 PDF URL 和 `%PDF-` 文件签名的检查；归档路径更新为 `output/t37/`。本地只验证了工作流配置，尚未执行远程作业。 |
| T37.4 Docker 运行验收 | 待环境 | 本机无 Docker CLI，且 `BRICKBILL_SMOKE_TOKEN` 未设置；没有运行 Compose 构建、备份、空卷恢复或容器 PDF 检查。 |
| T37.5 客户项目试点 | 待材料 | 当前可见的项目样本明确为合成 fixture；没有客户 Excel 模板、脱敏 MES 样本、独立业务基准、身份授权材料或目标 Office/WPS 环境。未生成客户通过结论。 |
| T37.6 自动验证与记录 | 已完成 | 本记录和任务表已更新；自动验证、PDF、Docker、客户状态分别记录如下。 |

## 自动验证

- `npm run verify`：通过。主测试 111 项、Schema 3 项、Excel 3 项、PDF 1 项、API 2 项、部署 18 项、宿主 2 项通过，合计 140 项通过、3 项跳过、0 项失败。TypeScript 检查及 Vite 生产构建通过。
- `npm run test:e2e`：6 项通过、0 项失败。浏览器 PDF 检查受运行环境控制；本机未配置 PDF Python/字体，因此该分支没有执行。
- T37 定向回归先验证了三个原始缺口：忽略终止信号且不触发 `close` 的子进程未在时限内失败；acceptance v1 绕过显式部署证据版本检查；Docker CI 未要求 PDF。修改后这三项回归通过。
- 部署回归覆盖辅助容器名称/所有权标签与错误运行标识拒绝、历史证据兼容、未知版本拒绝、v3 摘要错配失败，以及 Docker CI 的 PDF 必检配置。
- `git diff --check`：通过，exit 0。Git 提示既有 `TemplateDesigner.vue` 的 CRLF 行尾将在后续 Git 操作中转换为 LF；没有空白错误。
- 构建成功，保留依赖的 `use client` 提示及约 9 MB 主 JS chunk 大小提示。

## PDF 状态

本机 `npm run verify` 中 PDF 主测试 1 项通过，另 3 项因未配置 PDF runtime 和字体而跳过；E2E 的 PDF 断言同样因环境未配置而跳过。T37 已让 Docker CI 在配置好 ReportLab 和 CJK 字体后强制执行现有 PDF URL/签名检查，但由于本机无 Docker 且没有远程 CI 结果，容器 PDF 尚无实际通过证据。

## 待完成的外部验收

- Docker Engine/Compose 与烟测令牌可用后，运行 `npm run test:compose-smoke`，确认辅助容器标签清理、容器 PDF、空卷恢复、依赖核验及 generation 重印；工作流配置和本地单测不能替代实际运行。
- 取得至少两份客户模板、脱敏合同/物料/检化验关联样本、业务批准的 BFR 或人工基准、身份授权材料及目标 Office/WPS/字体环境后，使用现有项目接入 CLI 和比较器完成试点。缺少材料时保持待验收。

T37 没有新增证据版本，也没有重建采集、视图、分页、导出、模板匹配或账号管理平台。

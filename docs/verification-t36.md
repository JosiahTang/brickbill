# T36 实现与验收记录

日期：2026-10-21。按 T36.1 → T36.6 执行。保留工作区已有 T30—T35 及此前未提交改动；没有提交或推送 Git。

## 逐项状态

| 任务 | 编码状态 | 验证/环境状态 |
| --- | --- | --- |
| T36.1 隔离烟测入口 | 已完成 | 只允许显式合成 `dalipu-demo`；传入已有 generationId 会在启动 Docker 前失败。客户已有记录继续使用 `smoke:deployment` 指向已部署服务。定向测试覆盖真实脚本的启动前拒绝。 |
| T36.2 归档恢复安全性 | 已完成 | 恢复辅助容器以 root 读取归档并写入卷，完整检查归档后解包并恢复 `10001:10001` 属主；查找目标目录错误明确失败；备份和恢复子进程有 5 分钟上限及终止处理。参数与超时回归通过，真实 Docker 解包仍待环境运行。 |
| T36.3 固定依赖核验 | 已完成 | 烟测从 generation 快照读取精确模板修订、视图版本和函数版本，读取模板引用资源并计算摘要；模板、视图、函数定义及资源内容摘要参与同一依赖摘要。定向测试覆盖依赖缺失、版本错配、资源变化和固定模板内容变化；本地 API 烟测也通过。 |
| T36.4 证据与验收 CLI | 已完成 | 部署证据升至 `deploymentEvidenceVersion: 3`，包含恢复前后依赖摘要与数量；验收 CLI 对 v3 校验归档字节。只有日志采集和本次资源清理完成后才写最终通过记录。CLI 归档篡改回归通过。 |
| T36.5 Docker 运行验收 | 待环境 | 当前没有 Docker CLI，也没有 `BRICKBILL_SMOKE_TOKEN`；未运行 Compose 构建、备份和空卷恢复，没有声称容器验收或远程 GitHub CI 通过。 |
| T36.6 本地验证与状态记录 | 已完成 | `npm run verify`、提权后 `npm run test:e2e`、`git diff --check` 和烟测脚本语法检查完成。真实客户验收仍待材料。 |

## 自动验证

- `npm run verify`：通过。主测试 111 项、Schema 3 项、Excel 3 项、PDF 1 项、API 2 项、部署 15 项、宿主 2 项通过；PDF 另有 3 项因未配置 PDF 运行环境而跳过。合计 137 项通过、3 项跳过、0 项失败。TypeScript 检查和 Vite 生产构建通过。
- `npm run test:e2e`：6 项通过。第一次在工作区沙箱中运行时，Chromium 启动报 `spawn EPERM`；按批准的命令提权重跑后 6 项通过。
- T36 定向回归覆盖已有 generationId 被隔离 Compose 烟测拒绝、恢复 root 权限/归档校验/超时终止、固定模板/视图/函数/资源摘要和 v3 证据规则。`project:acceptance` 对 v3 实际归档 SHA-256 的通过及篡改失败均有回归。
- `node --check`：`ci-compose-smoke.mjs`、`compose-smoke-result.mjs`、`compose-smoke-process.mjs`、`deployment-dependencies.mjs`、`deployment-evidence.mjs`、`smoke-deployment.mjs`、`project-onboarding.mjs` 均通过。
- `git diff --check`：通过，exit 0。Git 对既有 `TemplateDesigner.vue` 报告 CRLF 将来会转换为 LF；没有空白错误。
- Vite 构建保留既有依赖的 `use client` 提示和约 9 MB 主 JS chunk 大小提示；构建成功。

## 证据格式兼容

- Compose 恢复证据新增版本 3，部署验收清单仍为版本 2，备份归档摘要仍为 `backupEvidenceVersion: 1`。
- 历史 `deploymentEvidenceVersion: 2` 继续按 v2 原字段校验，缺少依赖摘要不视为执行过 v3 核验。未标部署证据版本的旧材料继续按历史规则读取；只有重启材料仍为 pending。未支持的明确版本号失败。
- 通过结果只在日志收集、Compose 清理以及本次卷/镜像检查完成后写入。清理或日志错误会生成失败证据并保留主错误和清理错误。

## 待完成的外部验收

- Docker Engine/Compose 可用后，运行 `npm run test:compose-smoke`，确认 Linux 容器内 root 解包、目录属主、固定依赖恢复及最终证据完整。
- 真实客户试点仍缺客户 Excel 模板、脱敏 MES 关联数据、业务认可的独立 BFR/人工基准、身份授权材料和目标 Office/WPS/字体环境。取得材料后沿用现有项目接入 CLI 和比较器；在此之前客户验收保持待材料。

本阶段没有重建采集、视图、分页、导出、模板匹配或账号平台。当前工作区原有改动均予保留。

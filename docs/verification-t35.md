# T35 实现与验收记录

日期：2026-10-21。按 T35.1 → T35.6 顺序实施。保留工作区原有 T30—T34 改动；未提交或推送 Git。

## 逐项结果

| 任务 | 编码状态 | 验证和边界 |
| --- | --- | --- |
| T35.1 烟测端口与目标隔离 | 已完成 | Compose 烟测强制 loopback 和随机 host port，从 `docker compose port` 解析本次服务地址；拒绝非本机、无效或多重地址。合成 generation 需明确启用；真实项目须提供已有 generationId，健康检查不能代替单据核验。 |
| T35.2 数据卷备份 | 已完成 | 停止写入后按 Compose 项目及卷标签唯一定位源数据卷，以只读方式流式打包并计算 SHA-256。备份记录不含服务令牌。实际 Docker 命令待 Docker 环境运行。 |
| T35.3 空卷恢复 | 已完成 | 创建本次独有且带所有权标签的恢复卷；容器内先检查空目录，再解包并恢复文件属主。第二个 Compose 项目从恢复数据读取并重印原 generation，比较项目、generationId、页数及 XLSX SHA-256。实际 Docker 命令待 Docker 环境运行。 |
| T35.4 CI 与证据绑定 | 已完成 | CI 工作流改为生成、重启、备份、空卷恢复和原记录重印，并归档输出及日志。部署证据使用 `deploymentEvidenceVersion: 2`，备份摘要文件使用 `backupEvidenceVersion: 1`；验收清单仍为 v2。`project:acceptance` 会流式校验归档 SHA-256，并拒绝路径穿越或越界符号链接。历史无部署证据版本字段的清单保持既有读取规则；只有重启证据仍为 pending。 |
| T35.5 真实项目试点 | 待真实材料 | 当前没有客户原始 Excel、脱敏 MES 数据、业务批准的 BFR/人工基准和目标部署/办公软件环境。没有用演示项目生成客户通过记录。 |
| T35.6 本地回归与文档 | 已完成 | 本记录、部署说明及任务表已更新；完整自动验证通过。 |

## 自动验证

- `npm run verify`：通过。主测试 111 项、Schema 3 项、Excel 3 项、PDF 4 项、API 2 项、部署 10 项、宿主 2 项，共 135 项通过，0 失败，0 跳过；TypeScript 检查和 Vite 生产构建通过。
- `npm run test:e2e`：通过，6 项通过、0 失败，包含两个演示项目的配置流程和导入、拖拽、分页、保存、发布及 XLSX/PDF 生成流程。
- 新增部署定向回归覆盖随机端口与地址校验、真实 generation 要求、卷标签和只读备份参数、空卷恢复证据、归档哈希错配及路径越界。`project:acceptance` 回归确认归档被篡改后部署证据失败。
- `node --check`：烟测、部署证据和接入 CLI 脚本通过。
- `git diff --check`：通过（exit 0）。Git 提示现有 `TemplateDesigner.vue` 的 CRLF 行尾会在后续 Git 操作中转换；检查没有空白错误。

## 待环境和材料

本机未找到 Docker CLI，且 `BRICKBILL_SMOKE_TOKEN` 未配置。因此没有运行 `npm run test:compose-smoke`，也没有声称容器恢复或远程 GitHub CI 已通过。CI 工作流已配置该作业，需在具备 Docker 的 runner 上实际运行。

真实项目试点还需多客户原始 Excel 模板、脱敏合同/物料/检化验样本及关联说明、独立业务批准基准、身份权限材料和目标 Office/WPS/字体环境。取得材料后使用现有项目接入 CLI 和比较器逐项对照；缺少任一输入时，T35.5 及 customer acceptance 保持待验收。

当前没有增加第二套采集、匹配、分页或导出实现；没有提交或推送 Git。

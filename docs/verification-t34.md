# T34 实现与验收记录

日期：2026-10-21。按 T34.1 → T34.6 顺序执行。开始前保留工作区既有 T30/T31/T32/T33 未提交改动；未提交或推送 Git。

## 逐项交付

| 任务 | 状态 | 证据与边界 |
| --- | --- | --- |
| T34.1 clean/dirty Git 基线 | 已完成 | 验收回归在隔离临时仓库分别检查 clean 和 dirty 工作区；不依赖当前 brickbill 工作区有未提交修改。 |
| T34.2 清单与证据结构检查 | 已完成 | `project:acceptance` 对 null/数组/字段类型、未知和重复类别、无效版本、异常 comparison case 及缺少客户批准信息报告结构错误，不因单份证据形状导致崩溃；继续汇总剩余检查。 |
| T34.3 数据和输出对照分开 | 已完成 | acceptance v2 要求 `data-comparison` 与 `output-comparison` 两类报告。输出必须来自 snapshot 比较并核对 generation、模板版本、页数、XLSX SHA-256 和比较状态。客户数据/输出基准须提供 `sourceKind=customer`、`referenceId`、`approvedBy`、可解析的 `approvedAt`。历史 v1 仍可读取；客户 v1 因缺少输出对照标为 `pending`，v1 合成清单仍为 `simulation-only`。 |
| T34.4 证据和打印审批绑定 | 已完成 | v2 清单固定每份 JSON 证据 SHA-256；打印材料记录自身 SHA、generationId、模板版本及 XLSX SHA，并核对与通过的输出对照一致。报告记录检查时 Git HEAD/dirty 状态和证据 SHA。v1 原字符串样张兼容读取，但客户 v1 不会完整通过。 |
| T34.5 部署烟测和恢复状态 | 本地代码完成；Docker 待环境 | Compose 命令使用每次运行的唯一项目名，烟测前后要求项目、generationId、页数和文件哈希一致。v2 部署证据只有重启检查时为 `pending`；通过还需空目录/空卷恢复后同 generation、页数和 SHA。单测覆盖隔离参数和恢复证据错配。本机未安装 Docker，未运行 Compose。 |
| T34.6 文档与本地回归 | 已完成 | 已更新本文件、任务表和项目对照说明；最终自动验证见下。真实客户验收仍等待 T33.6 材料和环境。 |

## 自动验证

- `npm run verify`：通过。测试组共 130 项通过、0 失败、0 跳过；`vue-tsc --noEmit` 和 Vite production build 通过。构建输出仍有依赖的 `use client` bundling 提示及单个大 bundle 提示，不影响本次成功状态。
- `npm run test:e2e`：通过，6 项通过、0 失败。包括 T32 配置回归、两个示例项目的模板配置流程，以及导入、拖拽、分页、保存、发布、XLSX/PDF 生成流程。
- `git diff --check`：通过，无空白错误。
- 本机 Docker 探测结果：不可用；`BRICKBILL_SMOKE_TOKEN`、`BRICKBILL_SMOKE_URL` 未配置。Compose 烟测因此未执行，保持待环境。

## 项目验收边界

没有真实客户 Excel、脱敏 MES 数据、业务批准的独立 BFR/人工基准、企业身份设施及 Office/WPS 实印材料，不能标记 T33.6 客户试点通过。v2 格式让客户数据对照、生成快照输出、打印审批和空目标恢复证据可以互相核对；汇总器核验的是报告内容与文件绑定，不替代业务人员审批，也不声称其自行访问 MES 或实际操作 Docker/Office。

本阶段未新增采集、视图、分页、导出、匹配或账号管理平台；没有提交或推送 Git。

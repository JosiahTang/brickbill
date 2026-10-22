# T38 实现与验收记录

日期：2026-10-21。按 T38.1 → T38.6 顺序执行。开始时工作区已有 T30—T37 及此前改动；本轮保留这些改动，不提交或推送 Git。

## 逐项状态

| 任务 | 编码状态 | 验证/环境状态 |
| --- | --- | --- |
| T38.1 备份归档与辅助容器清理边界 | 已完成 | 独占创建归档；只有当前烟测实际创建的文件才会清理。回归确认 EEXIST 时保留原归档、部分归档可清理；容器已自行退出视为清理完成，Docker daemon 错误仍失败。定向测试通过，真实 Docker 清理尚未演练。 |
| T38.2 PDF smoke 与验收 CLI 兼容性 | 已完成 | 真实 `smoke-deployment.mjs` 由本地 HTTP mock 驱动；缺少 generationId、PDF URL、PDF 下载 HTTP 失败和错误 `%PDF-` 签名均被拒绝。CLI 回归确认未标版本的历史 acceptance v1 部署证据可读，未知显式版本及 v3 依赖摘要不一致失败。没有更改证据格式。 |
| T38.3 本轮 smoke 归档路径 | 已完成 | 修复烟测写入 `output/t37/`、CI 上传路径/名称仍为 T37 的不一致，统一为 `output/t38/` 和 `t38-compose-backup-restore-smoke`。针对旧路径的回归先失败，修改后通过。 |
| T38.4 实际 PDF 渲染验收 | 待环境 | 本机未配置 `REPORTING_PDF_PYTHON`、`REPORTING_PDF_FALLBACK_FONT` 或 PDF 输出路径。`npm run verify` 的 PDF 测试 1 项通过、3 项因缺少渲染器/字体跳过。mock PDF smoke 只核对 URL、HTTP 状态和签名，不代表实际渲染或字体/分页验收。 |
| T38.5 Docker 与客户项目验收 | 待环境 / 待材料 | 未发现 Docker CLI，`BRICKBILL_SMOKE_TOKEN` 未配置，因此未运行 Compose 烟测。现有项目样本 README 明确为合成数据；没有客户 Excel 模板、脱敏 MES 数据、独立业务基准、客户身份授权或目标 Office/WPS 环境，未生成客户通过结论。 |
| T38.6 自动验证与记录 | 已完成 | `npm run verify`、`npm run test:e2e`、`git diff --check` 均完成；分项结果见下文。 |

## 自动验证

- `npm run verify`：通过。主测试 112 项、Schema 3 项、Excel 3 项、PDF 1 项通过且 3 项跳过、API 2 项、部署 20 项、宿主 2 项通过；共 143 项通过、3 项跳过、0 项失败。TypeScript 检查与 Vite 生产构建通过。
- `npm run test:e2e`：6 项通过、0 项失败。完整浏览器工作流通过；由于本机 PDF 渲染器/字体未配置，不能据此认定 PDF 实际渲染验收通过。
- `git diff --check`：通过，exit 0。Git 提示既有 `src/components/TemplateDesigner.vue` 的 CRLF 行尾会在后续 Git 操作中转为 LF；没有空白错误。
- T38.1—T38.3 定向回归均通过；T38.3 的路径断言在修复前先失败，确认回归可识别旧配置。
- 构建仍有依赖 `use client` 指令提示及约 9 MB 主 JS chunk 大小提示；不影响构建退出状态。

## 验收边界

PDF smoke 集成测试使用模拟服务和小型签名样本，只证明 smoke 会拒绝缺失或错误 PDF 响应。真实 PDF 页面数、中文字体嵌入、版式及容器 PDF 状态仍待配置了 ReportLab/pypdf 与 CJK 字体的运行环境或成功的 Docker CI 记录。

Docker/令牌准备好后，运行 `npm run test:compose-smoke`，验收生成、重启、备份、空卷恢复、依赖核验、重印及清理；工作流配置和单测不能替代实际 daemon 运行。取得客户模板、脱敏业务样本、独立批准基准、身份授权和 Office/WPS 环境后，再通过现有项目接入 CLI 与比较器开展试点。

T38 未重建采集、视图、分页、导出、模板匹配或账号平台；没有改变部署证据格式，也没有提交或推送 Git。

## T39 环境复核勘误

T39 复核了 T32 已记录的运行环境：捆绑 Python 路径和 `C:\Windows\Fonts\simhei.ttf` 均实际存在，Python 中 ReportLab、Pillow、pypdf 也可导入。T38 执行时 PDF 测试环境变量未设置，因此测试按条件跳过；这只能说明当时未配置并执行实际 PDF 检查，不能说明依赖或字体缺失。T38 当时的自动验证结果保持原样，本段更正环境解释。

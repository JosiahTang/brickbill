# T41 实施与验收记录

日期：2026-10-21。按 T41.1 → T41.6 执行。开始时工作区已有 T30—T40 等未提交改动；原改动均予保留，本轮未提交或推送 Git。

## 逐项状态

| 任务 | 编码状态 | 实际验收状态 |
| --- | --- | --- |
| T41.1 Compose 命令等待 | 已完成 | 复用 `compose-smoke-process.mjs` 的 TERM/KILL 有界等待；镜像构建期限 15 分钟，重启/停止、创建和恢复启动按阶段设限。回归验证超时、忽略 TERM、spawn 错误及非零退出。 |
| T41.2 Docker 清理错误 | 已完成 | 卷、镜像、辅助容器的检查与删除都检查退出结果并设 60 秒上限。只有明确的资源不存在错误可忽略；daemon、权限和超时错误进入清理错误，卷标签不匹配也失败。 |
| T41.3 烟测结果落盘 | 已完成 | 主流程失败、清理失败或两者同时失败时写入失败证据；保留主错误和全部清理错误，失败结果不能保持 `passed`。无恢复记录时仍写入失败原因。 |
| T41.4 真实 Docker/Compose | 待环境 | 本次 `Get-Command docker` 与常见 Docker 安装路径均未发现 CLI，未运行真实镜像构建、daemon、Compose 命名卷备份恢复。 |
| T41.5 客户双模板试点 | 待材料 | 未发现 `acceptance/`、`config/`、`samples/` 客户验收目录或真实 Excel 模板。现有达力普与通用 MES README 均明确使用合成数据；没有真实 MES 样本、批准基准和客户 Office/WPS 结果。 |
| T41.6 自动验证和记录 | 已完成 | PDF 环境下 `npm run verify`、`npm run test:e2e` 及 `git diff --check` 均通过；部署证据版本保持原样。 |

## 回归先行与修改

- T41.1：新增测试先因 `runChildProcess` 导出不存在而失败。实现后，该测试通过忽略 TERM 的子进程验证宽限期后触发 KILL，并验证退出码 2 和 spawn error 均拒绝。Compose 长镜像构建上限为 900 秒；重启、等待、停止、创建、恢复启动有各自期限；备份和归档恢复继续复用原有 300 秒等待器。
- T41.2：新增的缺失资源分类与 Docker 结果测试先因结果检查器未实现而失败。现在只有明确的 `no such image`、`no such volume`、`no such container` 等错误视为资源已不存在。命令超时（`spawnSync.error`）、daemon/权限失败和未知非零退出均作为清理失败报告。恢复卷仍需匹配本次 Compose 项目标签后才能删除。
- T41.3：新增证据落盘测试先因 `persistComposeSmokeOutcome` 未实现而失败。现有 `finalizeComposeSmokeOutcome` 保持原行为，新增持久化函数由生产烟测入口调用。测试覆盖主错误与清理错误并存、只有主错误、成功结果三种情况；不改变证据字段语义。
- 未增加部署证据版本或新的业务后台；v2/v3/v4 的既有兼容语义不变。

## 自动验证

T42 复核说明：上述 T41 进程测试使用事件替身，证据测试调用汇总和落盘函数，覆盖范围不包含完整 CLI 编排或操作系统真实终止；“缺少导出”导致的测试加载失败也不作为错误行为修复证据。T42 新增的实际错误行为回归和 CLI 编排覆盖见 [T42 验收记录](verification-t42.md)。

PDF 使用 T40 已登记且实际可运行的 Python/ReportLab/Pillow/pypdf 和 SimHei 字体；没有下载或安装依赖。

```powershell
$env:REPORTING_PDF_PYTHON = 'C:\Users\87790\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$env:REPORTING_PDF_FALLBACK_FONT = 'C:\Windows\Fonts\simhei.ttf'
$env:BRICKBILL_REQUIRE_PDF_TESTS = '1'
Remove-Item Env:T22_PDF_SAMPLE_OUTPUT -ErrorAction SilentlyContinue
npm run verify
npm run test:e2e
git diff --check
```

- `npm run verify`：通过，exit 0。主测试 113、Schema 3、Excel 3、PDF 5、API 2、部署 26、宿主 2，共 154 项通过，0 失败、0 跳过；Vue/TypeScript 检查及 Vite 构建通过。构建仍有依赖 `use client` 提示和约 9 MB 主 chunk 提示。
- `npm run test:e2e`：受限运行首次因 Windows `spawn EPERM` 无法启动 Chromium；使用本机浏览器调试权限重跑成功，6 项通过、0 项失败（约 2.1 分钟）。
- `git diff --check`：通过，exit 0。Git 提示既有 `TemplateDesigner.vue` 将从 CRLF 转成 LF，不构成空白错误。
- 本轮命令输出保存在忽略提交的 `output/t41/`：`verify.log`、首次受限 `e2e.log`、授权重跑 `e2e-elevated.log`。

## 剩余实际验收

Docker 恢复后，使用现有 `npm run test:compose-smoke` 核对镜像构建、生成、服务重启、数据卷备份、空卷恢复、PDF/XLSX 重印、所有权保护及退出清理。取得真实客户模板、脱敏 MES 关联样本、独立批准基准和目标 Office/WPS 环境后，使用已有 project validate/probe/compare/acceptance CLI 完成双模板试点。上述验收均未以本地合成回归代替。

本轮保留所有工作区改动，没有自动提交或推送。

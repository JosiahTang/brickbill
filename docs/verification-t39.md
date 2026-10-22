# T39 实现与验收记录

日期：2026-10-21。按 T39.1 → T39.6 顺序完成。本轮保留开始时已有的工作区改动，不提交或推送 Git。

## 逐项状态

| 任务 | 编码状态 | 验证与验收状态 |
| --- | --- | --- |
| T39.1 PDF 必测与 CI | 已完成 | 新增 `BRICKBILL_REQUIRE_PDF_TESTS=1`；强制模式遇到 Python/字体不可用时直接失败，CI 已启用。缺运行环境的回归先失败后通过。 |
| T39.2 PDF 结构检查 | 已完成 | pypdf 对实际渲染 PDF 检查两页、中文文本、逐页图片和字体嵌入；不依赖 `T22_PDF_SAMPLE_OUTPUT`，临时产物会清理。无样张路径的测试通过。 |
| T39.3 渲染器有界等待 | 已完成 | PDF 渲染子进程复用现有等待器；忽略 TERM 的模拟子进程会在宽限期后 KILL 并在界限内失败。定向回归通过。 |
| T39.4 PDF 恢复摘要与证据兼容 | 已完成 | PDF smoke 记录 SHA-256 和字节数，重启及空卷恢复逐项比较；PDF 部署证据使用 v4，验收 CLI 检查 v4 PDF 摘要与备份归档。篡改归档回归先失败后通过；v2/v3 历史语义保持兼容。 |
| T39.5 本地 PDF、浏览器、Docker 与客户实测 | 本地可执行部分完成 | Python/SimHei 环境下实际 PDF 检查通过，完整浏览器 E2E 状态见下文。未发现 Docker CLI，且未配置 `BRICKBILL_SMOKE_TOKEN`，Compose 待环境；客户模板、脱敏 MES 样本、独立业务基准和办公软件材料缺失，客户验收待材料。 |
| T39.6 验证与记录 | 已完成 | 已运行全量 verify、浏览器 E2E 和 `git diff --check`；不自动提交或推送。 |

## 运行环境与自动验证

已复核 T32 登记的本地运行时，不以环境变量未设置判断依赖缺失：Python 可执行文件和 SimHei 字体文件均存在；ReportLab 4.4.9、Pillow 12.3.0、pypdf 6.10.0 均可导入。PDF 验证命令使用：

```powershell
$env:REPORTING_PDF_PYTHON = 'C:\Users\87790\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$env:REPORTING_PDF_FALLBACK_FONT = 'C:\Windows\Fonts\simhei.ttf'
$env:BRICKBILL_REQUIRE_PDF_TESTS = '1'
Remove-Item Env:T22_PDF_SAMPLE_OUTPUT -ErrorAction SilentlyContinue
npm run verify
npm run test:e2e
git diff --check
```

- `npm run verify`：通过，150 项通过、0 项跳过、0 项失败；包括主测试 113、Schema 3、Excel 3、PDF 5、API 2、部署 22、宿主 2 项。Vue/TypeScript 检查及 Vite 生产构建通过。
- PDF：实际渲染并用 pypdf 检查页数、中文、图片和字体嵌入；样张保存开关未设置，5 项通过、零跳过。
- `npm run test:e2e`：通过，6 项通过、0 项失败（约 1.6 分钟）。首次受限执行在浏览器启动时报 Windows `spawn EPERM`，没有进入测试；清理本次遗留的 API/Vite 进程后，在获准的本地调试环境重跑，六项完整浏览器流程均通过。
- `git diff --check`：通过，exit 0；Git 对既有 `TemplateDesigner.vue` 的 CRLF→LF 提示不是空白错误。

T39 的新回归涵盖严格 PDF 模式缺依赖失败、实际 PDF 结构检查、忽略 TERM 的 renderer 子进程、重启/恢复 PDF 摘要不一致，以及 v4 备份被篡改时验收 CLI 拒绝；每项在修改前先确认回归能识别错误行为。证据格式仅 PDF 部署证据升至 v4；旧 v2/v3 继续按原规则验证。

## 环境与客户验收边界

本地实际 PDF 渲染及解析已完成。当前环境没有 Docker CLI，未设置部署烟测令牌，因此没有运行真实 Docker/Compose 生成、重启、备份、空卷恢复和重印；该部分保持待环境。没有真实客户 Excel 模板、脱敏 MES 关联数据、独立批准的业务结果或目标 Office/WPS 环境，因此客户版式与生产数据验收保持待材料，不把合成回归或 mock 当作客户通过证据。

T39 复核后已在 [T38 验收记录](verification-t38.md) 补充勘误：Python、字体和依赖存在，T38 的跳过由当时未设置验证环境变量造成，而非依赖缺失。没有重建采集、视图、分页、导出、模板匹配或账号平台。

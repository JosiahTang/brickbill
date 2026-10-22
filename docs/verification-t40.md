# T40 实现与验收记录

日期：2026-10-21。按 T40.1 → T40.6 顺序执行。开始时工作区已有 T30—T39 等未提交改动，本轮保留原改动，不提交或推送 Git。

## 逐项状态

| 任务 | 编码/本地状态 | 实际验收状态 |
| --- | --- | --- |
| T40.1 API 镜像运行依赖 | 已完成 | 新回归按 Dockerfile API 阶段的本地 COPY 输入组装系统临时目录，仅显式链接依赖目录；旧运行包因缺少等待器模块先失败，补入单个 COPY 后真实 API 启动并返回健康检查。该测试不等同于 Docker 构建。 |
| T40.2 PDF 重印一致性 | 已完成 | 扩展现有 smoke 与 HTTP mock 回归，重印前后各下载一次实际 PDF，并比较 SHA-256 与字节数。旧代码未在重印前下载 PDF，回归先失败；修复后正常、等长替换、长度改变、第二次下载失败及原有错误场景均按预期处理。XLSX-only 不下载 PDF。 |
| T40.3 实际 PDF 空目录恢复 | 已完成 | 扩展原部署恢复测试，实际生成并缓存 PDF，停止 API 后复制完整数据到此前不存在的独立目录，再启动恢复实例；同 generation、页数、PDF 摘要/字节数/全部字节一致。篡改文件或长度元数据时 HTTP 400/CONTRACT_INVALID，缓存保持原损坏状态，没有静默覆盖。 |
| T40.4 真实 Docker/Compose | 待环境 | PATH 查不到 Docker CLI，常用安装路径也无 docker.exe，未设置 BRICKBILL_SMOKE_TOKEN；没有执行容器构建、daemon/Compose、命名卷备份恢复或远程 CI。 |
| T40.5 客户双模板试点 | 待材料 | 当前未发现 acceptance/config/samples 客户材料目录；现有达力普与第二项目 README 明确是合成模板/数据。缺真实 Excel 双模板、脱敏 MES 关联数据、批准的独立基准、身份授权及 Office/WPS 环境，未生成客户通过结论。 |
| T40.6 全量验证和文档 | 已完成 | 部署、证据及任务书已同步；verify、E2E 和差异检查均通过，环境/客户验收状态分别记录。 |

## 最小修复及回归记录

- T40.1：先失败为 `ERR_MODULE_NOT_FOUND`，定位隔离目录中的 `scripts/compose-smoke-process.mjs`；Dockerfile API 阶段补一个 COPY 后，隔离目录启动回归通过。继续复用原有等待器，未另建进程管理程序。
- T40.2：先失败为重印前 PDF 下载次数为 0；烟测提取本地 PDF 摘要读取函数，在原重印调用两侧读取并比较。新增错误场景通过真实 smoke 子进程运行，不以字符串断言替代行为验证。
- T40.3：首轮实际 PDF 测试发现合成示例模板单元格 `3:2` 高度溢出，所需 24.2pt、可用 14pt。按现有表头标签之间的空闲列合并值区域、分节标题及声明，补齐附页证书号区域后通过；没有放松渲染溢出检查、缩小字号或修改业务分页引擎。已有缓存损坏校验符合要求，仅增加恢复场景回归。
- 首轮完整 verify 的 T27 合成输出对照发现旧合并基准仅列出 A1:P2。同步测试及 `dalipu-multipage-output-synthetic.json` 中明确的预期合并区域后，T27 定向回归通过；比较器保持严格相等校验。合成模板变化不迁移已有发布版本或生成快照，不修改客户批准基准。
- 首轮完整 E2E 为 5 项通过、1 项样本准备失败：旧测试手工增加 A43:P43，和现已正确提供该合并区的示例模板重叠。删除这一条过时准备代码后重跑完整浏览器流程；没有放松合并校验或浏览器业务断言。

## PDF 环境及最终验证

复核 T32/T39 登记的 Python 和字体文件存在，并实际导入 ReportLab 4.4.9、Pillow 12.3.0、pypdf 6.10.0。使用已有安装，不下载依赖。验证进程设置：

```powershell
$env:REPORTING_PDF_PYTHON = 'C:\Users\87790\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$env:REPORTING_PDF_FALLBACK_FONT = 'C:\Windows\Fonts\simhei.ttf'
$env:BRICKBILL_REQUIRE_PDF_TESTS = '1'
Remove-Item Env:T22_PDF_SAMPLE_OUTPUT -ErrorAction SilentlyContinue
npm run verify
npm run test:e2e
git diff --check
```

- `npm run verify`：通过，exit 0。主测试 113、Schema 3、Excel 3、PDF 5、API 2、部署 23、宿主 2，共 151 项通过，0 项失败、0 项跳过；Vue/TypeScript 与 Vite 生产构建通过。现有依赖的 use-client 指令和约 9 MB 主 chunk 提示仍在。
- `npm run test:e2e`：通过，exit 0，6 项通过、0 项失败（约 2.1 分钟），包括完整 Excel 导入/字段拖拽/分页配置/保存/发布/生成及 PDF 下载流程。沿用已允许的本地浏览器调试权限执行，避免 T39 已确认的受限进程启动 EPERM。
- `git diff --check`：通过，exit 0。Git 对既有 `TemplateDesigner.vue` 的 CRLF→LF 提示不是空白错误。

本地日志保存在忽略提交的 `output/t40/`；首次失败为 `verify.log`、`e2e.log`，最终结果为 `verify-final.log`、`e2e-final.log`。

## 证据兼容与后续验收

T40 没有增加部署证据版本：v2 沿用归档/恢复检查，v3 沿用固定依赖检查，v4 沿用并要求 PDF 摘要/长度。旧格式不会被补认具有新版检查。备份证据仍为 v1，验收清单仍为 v2；继续复用项目接入 CLI 和比较器。Compose 输出及 CI 归档路径保持现行 `output/t38/<run-id>/`，文档已订正旧的 t36 路径。

具备 Docker 和配置后执行现有 `npm run test:compose-smoke`，以真实容器日志验证生成、重启、备份、空卷恢复、依赖核验、XLSX/PDF 重印及清理。取得客户材料后，以同一采集/转化后台接入两份客户模板，用现有 validate/probe/compare/acceptance 和目标 Office/WPS 完成试点。两项均保持待验收，本地合成运行和回归不能替代它们。

本阶段没有重建采集、视图、分页、导出、模板匹配或账号平台；没有自动提交或推送 Git。

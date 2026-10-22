# T42 实施与验收记录

日期：2026-10-21。按 T42.1 → T42.4 顺序执行。开始时已核对 T41 记录及工作区 T30—T41 等未提交改动，保留原有改动，未提交或推送 Git。

## 逐项状态

| 任务 | 状态 | 证据及边界 |
| --- | --- | --- |
| T42.1 子进程错误与输出解析 | 编码及定向回归完成 | 旧 CLI 将 ENOENT 错误写成 `.trim()` TypeError，回归断言实际失败；修复后覆盖 ENOENT、EPERM、ETIMEDOUT、非零退出、空输出、非法 JSON 六种情况。 |
| T42.2 资源不存在判断 | 编码及定向回归完成 | 旧检查器吞掉 stderr daemon 错误与 stdout 缺失资源文本的组合，回归因缺少预期异常而失败；修复后拒绝混合诊断、错误输出位置、未知退出码、信号退出和资源类型不符。 |
| T42.3 实际烟测编排 | 定向回归完成 | 测试启动真实 Node CLI 子进程执行 `ci-compose-smoke.mjs`，仅在测试侧预加载替换子进程边界；生产编排、归档流、摘要计算、文件写入、汇总和退出逻辑均运行。覆盖成功、主流程与清理同时失败、仅清理失败。 |
| T42.4 全量验证及文档 | 已完成 | verify 157 项通过、E2E 6 项通过、构建和差异检查通过；T41 覆盖边界已补充说明。 |
| 延续 T41.4 Docker/Compose | 待环境 | PATH 与常见安装路径均未发现 Docker CLI，未设置烟测令牌；未执行真实容器构建或命名卷备份恢复。 |
| 延续 T41.5 客户双模板 | 待材料 | 未发现 acceptance/config/samples 客户材料目录；达力普和第二项目 README 明确为合成/模拟输入，尚缺真实模板、MES 样本、批准基准及目标 Office/WPS 验收。 |

## 行为回归和最小修改

### T42.1

测试通过测试侧预加载模块提供一个带 `error.code = ENOENT`、无 stdout/stderr 的进程结果，再启动实际 CLI。旧代码完成清理并写出的 `compose-failure.json` 中，`primaryFailure` 为 `Cannot read properties of undefined (reading 'trim')`，不满足 `/ENOENT/` 断言。该失败来自实际运行行为，不是缺少导出或测试加载失败。

修复仅在原 `readSmoke()` 内优先保留子进程 error/code/cause，将可空输出规范成字符串；非零退出、无 JSON 输出、最后一行非法 JSON 分别返回明确诊断。正常 JSON 结果路径由 T42.3 成功流程验证，继续按最后一行读取结果。

测试预加载路径在 Windows 上需使用 file URL。测试引导开发时出现过路径加载错误，修正后重新取得上述行为失败证据；引导错误不计入行为修复证据。

### T42.2

旧 `assertDockerCommandResult()` 对 `{status: 1, stderr: 'Cannot connect to the Docker daemon', stdout: 'No such image: sample'}` 返回 false。新增回归在旧实现上报 `Missing expected exception`。

现有检查器现在仅在退出码为 1、stderr 全部为对应资源的明确缺失诊断、stdout 为空或 Docker inspect 的空数组 `[]` 时忽略。daemon/权限混合诊断、stdout 单独出现缺失文本、异常退出码、信号退出、其他资源类型均拒绝。原来的正常缺失容器、镜像、卷（含 `get <volume>: no such volume`）行为通过回归保留。

### T42.3

继续使用 `tests/deployment.test.mjs`。新增 `tests/fixtures/deployment/compose-process-stub.mjs` 只由测试 Node 的 `--import` 参数加载；生产代码没有测试开关，也没有新增编排器。

- 成功路径：真实 CLI 退出 0；生成 v3 恢复结果、备份归档和摘要、两套日志；没有失败文件。
- 主流程加清理失败：首个 Compose 构建命令返回 7；后续辅助容器检查、日志、两套 Compose down 和镜像清理仍继续。失败文件保留原始 `exited 7` 及全部清理错误，CLI 退出 1，没有成功结果文件或成功提示。
- 仅清理失败：生成、重启、流式备份、恢复和比较完成后注入清理失败；其余清理继续，Compose down 失败后仍核对并清理所属恢复卷；最终结果被标记 failed，失败文件记录清理错误，CLI 退出 1。

这些测试证明实际编排及进程退出行为；Docker 和烟测子进程的返回值由测试替身提供，归档内容为测试字节，不能证明真实容器、tar 解包、MES 或客户输出通过。

## 验收表述和证据兼容

T41 的等待器测试使用进程事件替身，证据写入测试直接调用汇总/持久化函数；它们没有覆盖完整 CLI 编排，也不能单独证明操作系统实际终止进程。T41 的“缺少导出”失败只证明接口尚未实现，不作为错误行为回归证据。T42.1、T42.2 补充实际错误行为的先失败记录，T42.3 补充实际 CLI 进程与文件证据。

部署证据 v2/v3/v4、备份证据 v1、验收清单 v2 保持既有字段与语义。旧格式不会被补认有新版检查；本轮没有修改比较器、版本仓库、业务采集、分页、导出或项目接入流程。

## 自动验证

已确认 Python 与 SimHei 字体文件存在，实际导入 ReportLab 4.4.9、Pillow 12.3.0、pypdf 6.10.0。复用现有安装，不下载依赖。验证配置：

```powershell
$env:REPORTING_PDF_PYTHON = 'C:\Users\87790\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$env:REPORTING_PDF_FALLBACK_FONT = 'C:\Windows\Fonts\simhei.ttf'
$env:BRICKBILL_REQUIRE_PDF_TESTS = '1'
Remove-Item Env:T22_PDF_SAMPLE_OUTPUT -ErrorAction SilentlyContinue
npm run verify
npm run test:e2e
git diff --check
```

- `npm run verify`：exit 0，主测试 113、Schema 3、Excel 3、PDF 5、API 2、部署 29、宿主 2，共 157 项通过、0 失败、0 跳过。Vue/TypeScript 检查与 Vite 生产构建通过。保留既有依赖 `use client` 提示和约 9 MB 主 chunk 体积提示。
- `npm run test:e2e`：沿用 T41 已核实的本机浏览器调试权限执行，exit 0，6 项通过、0 失败（约 1.7 分钟），包括双项目配置及 Excel 导入、拖拽、分页、保存发布、XLSX/PDF 生成下载。
- `git diff --check`：exit 0。既有 `TemplateDesigner.vue` 的 CRLF → LF 提示不是空白错误。
- PDF：启用 `BRICKBILL_REQUIRE_PDF_TESTS=1`，实际 PDF 结构、渲染及恢复验证通过；不设置额外样张输出开关，PDF 测试零跳过。

定向 T42 三项已通过。行为先失败、修复后及全量输出保存在忽略提交的 `output/t42/`：`t42-1-red.log`、`t42-1-green.log`、`t42-2-red.log`、`t42-2-green.log`、`t42-entry-green.log`、`verify.log`、`e2e.log`、`diff-check.log`。

Docker 与客户材料不足时，继续保留 T41.4 待环境、T41.5 待材料。本轮保留全部工作区改动，不自动提交或推送 Git。

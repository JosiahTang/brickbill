# T44 图片一致性、区域边界与输出比较验收记录

实施日期：2026-10-21—2026-10-22。按任务书 T44.1 → T44.6 实施。开始时核对 Git 状态及 T43 记录，保留 T30—T43 累积未提交改动；没有提交或推送 Git。

## 逐项实现

| 任务 | 编码状态 | 复用入口与行为 |
| --- | --- | --- |
| T44.1 图片清单和资源权威 | 已实现 | 扩展现有 `src/export/workbookImages.ts` 写回函数，已定义清单控制实际 XLSX 原始图片集合；读取包资源字节，保留其他表和背景的共享引用。删除/重排后同步保存副本的 `sourceIndex`，连续保存重开可用。 |
| T44.2 空明细删行边界 | 已实现 | `src/domain/generate.ts` 继续使用既有 `rowMap`；整行底边属于前一覆盖行，避免将相邻已删除明细行当作图片内容。真正跨重复区域仍拒绝。 |
| T44.3 实际分页占用 | 已实现 | `src/core/render/page.ts` 小范围提取 `fixedRegionRect()`，复用 allocation 和 blankRows，供清理范围和图片冲突检查共用。修正 `fixed.ts` 中空白容量混用记录数与行数的问题；没有重算分页算法。 |
| T44.4 投影身份唯一 | 已实现 | 现有包验证在原始图和同工作表页面配置图标识冲突时返回 DUPLICATE_KEY，包含工作表及单元格定位。不同工作表局部 ID、同资源多个合法位置仍允许。 |
| T44.5 独立输出比较 | 已实现 | 原比较器支持 tl/br 和 tl/ext，坏锚点返回 IMAGE_ANCHOR_INVALID。比较套件 v2 可逐位置核对资源文件字节 SHA-256；实际 CLI 报告请求、已检查和匹配数量，错误内容退出 1。 |
| T44.6 集成与最终检查 | 本地完成；外部待验收 | 最终 verify、9 项完整浏览器测试、实际 PDF 检查及差异检查通过；Docker 和客户验收分别待环境、待材料。 |

没有增加依赖或新的画布、图片仓库、分页器、快照仓库、PDF 渲染器、账号平台及验收 CLI。原 `sha256()` 仅移到 `src/core/reporting/digest.ts` 共享，`server/repositories/local.ts` 保留同名重导出，原调用入口兼容。

## 图片写回契约与兼容

- 模板包仍为 contractVersion 2、文档仍为 schemaVersion 1、图片布局仍为 imageLayoutVersion 1；Excel 元数据标记不变。部署证据 v2/v3/v4 不变。
- `document.images === undefined` 继续按旧格式保留源图；清单已定义（含空数组）时，保存的可见原始图片集合、顺序、内容和锚点由清单及包级 resources 确定。
- `sourceIndex` 在写回前校验其确实引用导入源图，缺失时明确失败；不因资源存在而悄悄重建一个无法关联的源对象。写回后，仅序列化副本更新为新工作表图片顺序。调用者的模板、源工作簿、已发布版本和旧生成快照不被改写。
- 替换引用的资源时，不原地修改共享源媒体；相同编码字节及类型复用已有 Excel 媒体，避免每次保存持续累积重复字节。未使用的原工作簿媒体可能继续保留为保真数据，不承诺清除归档内所有未引用字节。
- ExcelJS 4.4 没有公开图片删除接口，本轮仅在原图片适配器内窄范围访问 `_media` 来保留背景并替换原始图片列表；没有通过整个 worksheet.model 重解析单元格、合并和表格。该依赖边界由保存/重开和多表回归约束。
- 图片字节读取复用 `imageResourceBytes()`，检查 base64、支持类型及 PNG/JPEG/GIF 文件签名/完整结束标记，拒绝明显损坏、截断及缺失资源；这不是完整图片编解码器。浏览器显示和实际 PDF 渲染继续由现有图片解码器验证内容。
- 本地单表生成可传入现有模板包 resources；旧单文档调用没有包资源时继续从对应源图读取。没有新增删除、替换、旋转或裁剪原始图片的 UI。

## 比较套件 v2

`ProjectComparisonSuite.suiteVersion` 支持 1/2。v2 的 `generation.xlsx.images[]` 可增加 `contentSha256: string[]`，长度等于 count，每项为 64 位小写 SHA-256，按现有工作表图片位置顺序绑定。摘要比较的是图片编码文件的 buffer 或 base64 解码字节，不是资源标识、整份 XLSX 哈希或解码像素。

v1 不含新字段时维持原检查能力；v1 夹带内容断言、未知套件版本及坏摘要拒绝。内容断言只允许在 snapshot 模式对实际 XLSX 执行，offline/online 不会忽略内容断言并报通过。

比较报告保留 reportVersion 1，添加来源字段 suiteVersion 和计数 imageContentChecks（requested/checked/passed），输出比较子结果也记录计数。旧报告缺失字段表示没有该证据，不能补认通过。兼容说明同步于 `docs/project-comparison.md`。

## 错误行为和回归证据

日志保存到忽略提交的 `output/t44/`：

- `t44-1-red.log`：旧实现空清单仍保存两图；新资源字节未写入；仅保留第二图时仍有两图；明显损坏内容未拒绝。
- `t44-2-red.log`：图片底边恰与被删除空明细起点相接时，旧实现抛出“图片定位对应的行已被删除”。修复后相邻图片保留，后方小数锚点上移且物理尺寸不变。
- `t44-3-red.log`：图片位于展开或空白容量区域时没有预期错误。后续定向验证覆盖零/一/多记录、主续页、recordHeight、独立明细列区域及安全边界。
- `t44-4-red.log`：原始与配置图片使用相同 ID 时没有预期错误；修复后拒绝，同时验证跨表同名及共享资源合法。
- `t44-5-red.log`：真实 tl/ext 图片导致 TypeError；独立基准指定错误图片摘要时，旧比较器仍返回 passed。套件 v2 尚未被识别的失败仅说明新格式未实现，不单独算行为修复证据。
- `media-growth-red.log`：本轮写回初版在第二次保存将媒体条目从 3 增至 5；增加内容复用后，重复保存媒体数量稳定。
- `save-race-red.log`、`save-race-controlled-red.log`：最终集成中发现已保存的图片模板仍显示修订 0。控制初始模板列表及保存应答顺序后复现同样错误；旧列表改变选择，导致自身保存应答被判过期。原设计器保存前现固定当前编辑模板，并递增既有选择序号，借助原上下文检查拒绝过期结果；数据目录未就绪时保存按钮等待。`save-race-controlled-green.log` 在相同顺序下修订 1、发布按钮及远端图片内容验证通过。
- `save-refresh-overcancel-red.log`：上述修复初版还取消了整个列表刷新，导致 T32.4 用例无法选择刚请求刷新的另一模板。移除这一过度取消，保留正常列表更新及用户切换；`save-races-green.log` 中 T32.4 和迟到初始列表两个受控回归均通过，没有放宽过期应答保护。
- `test-observation-race.log`：T32.3 原测试在点击保存后立即通过独立 HTTP 客户端读取模板，有时早于异步 PUT 完成而读到旧视图。仅补充等待页面修订 3 的可观察完成信号，再核对远端 New view；未改变产品视图重载逻辑或放宽内容断言。
- 定向通过记录：`t44-1-green.log`、`t44-2-green.log`、`t44-3-green.log`、`t44-4-green.log`、`t44-5-green.log`、`t44-5-cli-green.log`、`images-green.log`、`pdf-green.log`。部分为阶段记录，最终结果以全量日志为准。

测试编写期间修正过 PNG 测试常量的 CRC、续页数量预期、可选 pageDefinitions 的空值断言及浏览器脚本括号；这些不算产品缺陷证据。`browser-interrupted.log` 是浏览器运行期间修改模块导致 Vite 热重载、下载等待中断的记录，不算产品通过或失败证据。`e2e-layout-red.log` 进一步记录合成附表 D20 标签行高不足时 PDF 明确拒绝，随后仅将测试模板该行高度调整为 32px，保留引擎的实际文字溢出检查；最终完整套件重新执行。

## 实际集成覆盖

- `tests/images.test.mjs`：真实 XLSX 图片数量、编码字节、双重保存、索引、共享资源、未修改输入、删行后锚点、分页动态占用和投影身份。
- `tests/reporting-projects.test.mjs`：固定尺寸图片跨越已填行列仍可比较；坏锚点结构化失败；错误内容在整份 XLSX 与快照摘要自洽时仍被独立基准拒绝。
- `tests/project-onboarding.test.mjs`：使用现有快照仓库存放合成 XLSX 测试记录，启动实际 CLI，检查成功/失败退出、报告落盘、版本和内容计数。该测试记录不冒充客户生成或客户批准基准。
- `tests/pdf.test.mjs`：连续两次保存重开后实际渲染 PDF；空清单没有图；替换图片为实际 1×1 合成 PNG，解析 PDF 验证尺寸和白色 RGB 像素。T43 两页图片绘制次数和位置矩阵测试继续保留。
- `e2e/images-workflow.spec.mjs`：沿用原 Playwright 套件和 UI，覆盖空明细相邻图片的本地 Excel 导出、JSON 图片清单变更、连续保存重开、跨表局部同名、共享资源、错误 JSON 保留编辑状态、发布后生成时动态占位拒绝，以及合法主表/附页输出、切页和 XLSX/PDF 下载。
- 同套件增加受控迟到列表回归，实际 PUT 已写入远端后，旧列表先返回、保存应答后返回；确认页面修订和发布能力不会丢失。测试开发时曾错误要求尚未返回的列表含新模板选项，已改为等待实际响应及浏览器绘制周期；仅最终修订 0 的失败算作行为证据。
- 发布预检继续只解析模板依赖，不增加业务采集。需要实际分页计划的冲突在生成/投影阶段返回原有结构化错误并沿用 UI 定位链路；不将预检通过解释成已完成真实数据布局验收。

## 最终自动检查

复核本机已存在的 Python、SimHei 字体及依赖：ReportLab 4.4.9、Pillow 12.3.0、pypdf 6.10.0；未安装或下载依赖。

```powershell
$env:REPORTING_PDF_PYTHON = 'C:\Users\87790\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$env:REPORTING_PDF_FALLBACK_FONT = 'C:\Windows\Fonts\simhei.ttf'
$env:BRICKBILL_REQUIRE_PDF_TESTS = '1'
Remove-Item Env:T22_PDF_SAMPLE_OUTPUT -ErrorAction SilentlyContinue
npm run verify
npm run test:e2e
git diff --check
```

- 最终 `npm run verify`：exit 0。主测试 117、Schema 3、Excel 19、PDF 7、API 2、部署 29、宿主 2，合计 **179 项通过、0 失败、0 跳过**。Vue/TypeScript 检查及 Vite 生产构建通过（约 58 秒）；保留既有依赖的 use-client 和约 9 MB 主 chunk 提示。
- 最终 `npm run test:e2e`：exit 0，**9 项通过、0 失败**，约 2.6 分钟；包括原 T32/T29 配置流程、T43 图片闭环、T44 主附页图片一致性及受控保存应答竞态。未屏蔽页面错误或放宽内容、溢出、版本和修订保护断言。
- `git diff --check`：exit 0；既有 TemplateDesigner.vue 的 CRLF → LF 提示不是空白错误。
- PDF：启用必测开关且不设置额外样张保存开关，7 项零跳过；实际 PDF 解析、图片内容/矩阵以及浏览器下载通过。

最终日志为 `output/t44/verify.log`、`e2e.log`、`diff-check.log`。失败及定向记录独立保留，最终通过不改写中间失败原因。

## 外部验收状态

- **PDF**：合成样本的实际文件自动检查已运行；不代表真实客户模板、批准印章或目标打印机实印通过。
- **Docker**：`Get-Command docker` 未找到命令，T41.4 保持待环境。单元/API/进程替身不算真实容器及空卷恢复验收。
- **客户验收**：未收到本轮客户原始模板、MES 样本、独立批准基准、正式员工身份及 Office/WPS 环境，T41.5 保持待材料；没有生成虚假通过证据。
- 全部改动保留在当前工作区，不自动提交或推送。

# T32 实现与验收记录

日期：2026-10-20。范围：按 [T32 任务书](engineering-assessment-t32.md) 顺序完成必要字段解析、请求内匹配一致性、编辑基准、保存/发布恢复、诊断与历史回归和交付收尾。

## 逐项核对

| 任务 | 状态 | 修改入口 | 已获得的验收证据 |
| --- | --- | --- | --- |
| T32.1 | 已完成 | `server/services/generate.ts`、`tests/reporting-projects.test.mjs` | 未使用的空字段不阻断；停用/参数不符候选不触发采集；空值、空白、超长、冲突及空集合明确失败；多行同值通过；必要事实不能缺失后降级 |
| T32.2 | 已完成 | `server/repositories/local.ts`、`server/services/generate.ts`、服务测试 | 捕获候选后共用原优先级/歧义求值；采集等待期间修改规则或发布 v2，本次仍用原规则/v1，下次请求使用新规则/v2；发现模板停用时失败；生成只采集一次 |
| T32.3 | 已完成 | `src/stores/designer.ts`、`src/components/TemplateDesigner.vue`、浏览器回归 | A→B→A 保留 A 的修订 1，远端修订 2 拒绝旧保存；迟到 B 响应不回填 A；视图内容旧但远端修订新时拒绝发布，显式重载后内容与基准一起更新 |
| T32.4 | 已完成 | 同一设计器的保存/发布方法、既有配置浏览器流程 | 延迟保存应答期间改名仍禁止发布；再次保存后恢复；切换模板后的应答不重置当前选择/修订；两个项目均通过第三项发布故障、重试和前两项版本稳定检查 |
| T32.5 | 已完成 | 设计器、`src/services/reporting.ts`、服务/浏览器测试 | 参数或项目变化忽略旧匹配应答；失败清空旧依据；两个项目内客户 A/B 各选模板；变更规则后旧预览签发/重印无采集且原文件不变；旧快照缺匹配字段仍能重印 |
| T32.6 | 已完成（本地编码与回归） | 既有 Playwright 配置、任务/API/README 文档 | 全量 verify、完整 PDF、独立数据目录下 6 项浏览器回归及差异检查通过；Compose/真实项目验收单列待办 |

## 实现约定

- 继续使用项目适配器、字段目录、模板规则仓库、数据视图、公共函数、页面规划、XLSX、快照和签发接口，没有增加依赖或新的执行引擎。
- 匹配依赖仅来自启用且已知业务参数可满足的候选；必要字段集合由这些候选引用的采集字段并集决定。诊断中未知字段用 `pendingFields` 表示，不当作已比较失败。
- 仓库中提取 `evaluateTemplateMatches` 和 `selectTemplateMatch`，试算、生成和既有 `match` 共用原判定过程。请求内使用捕获的候选，不提供跨进程事务承诺。
- 设计器以加载会话、服务身份、项目和模板关联修订基准；刷新只更新观察值。独立视图差异须明确重新载入，不因打开模板而自动提升旧内容基准。
- 保存确认关联提交内容指纹，忽略快照生成过程推进的修订数字；实际新编辑仍被检测为未保存。批量发布使用提交开始时的定义副本，全部成功后才更新完整引用。
- 旧快照没有 `templateMatch` 时界面显示“模板匹配依据：未记录”；不从当前规则推断历史原因。

## 复现与验证命令

服务回归复用已有测试文件：

```powershell
node --experimental-strip-types --test --test-name-pattern='T31|T32' tests/reporting-projects.test.mjs
npm run test:e2e -- --grep 'T32.3|T32.4|T29 form'
npm run test:e2e -- --grep 'T32.5'
```

本机完整验证使用已有捆绑运行环境：Python 中 ReportLab 4.4.9、Pillow 12.3.0、pypdf 可用，字体为 Windows SimHei。只在验证进程设置环境变量，不改写生产配置。

```powershell
$env:REPORTING_PDF_PYTHON = 'C:\Users\87790\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$env:REPORTING_PDF_FALLBACK_FONT = 'C:\Windows\Fonts\simhei.ttf'
npm run verify
npm run test:e2e
git diff --check
```

PDF 样张的额外结构检查使用现有 `T22_PDF_SAMPLE_OUTPUT` 开关：

```powershell
New-Item -ItemType Directory -Path tmp -Force | Out-Null
$env:T22_PDF_SAMPLE_OUTPUT = Join-Path (Get-Location) 'tmp/t32-verification.pdf'
npm run test:pdf
```

样张位于忽略目录，不作为业务认可的正式输出基准。

## 验证结果与失败记录

- `npm run verify`：退出码 0。主测试 **105 项**、Schema **3 项**、Excel **3 项**、PDF **4 项**、API **1 项**、部署 **3 项**、宿主 **2 项**全部通过；Vue/TypeScript 与生产构建通过，PDF 零跳过。
- 带样张路径的 `npm run test:pdf`：**4 项通过，零跳过**；额外用 pypdf 核对 2 页、中文文本、逐页图片数量和字体嵌入。
- T32.3/T32.4 与双项目配置流程的定向浏览器回归：**4 项通过**。
- T32.5 诊断浏览器回归：**1 项通过**。
- 最终 `npm run test:e2e`：退出码 0，**6 项通过（1.8 分钟）**；包含原始 Excel 导入/拖拽/分页/发布/客户匹配/签发/重印与 PDF 下载、两个项目配置、视图发布故障恢复和三项新增浏览器场景。
- `git diff --check`：当前通过；保留现有 CRLF→LF 提示，不是空白错误。

针对性失败及修复证据：

1. T32.1 新回归最初因未使用 `cert.purchaser` 为空而报 `VALUE_TYPE_ERROR`；限定必要字段后通过。
2. T32.2 新回归最初在采集期间改规则后选中新模板；改为捕获候选求值后保持原模板，下一请求选新模板。
3. T32.3 沿用任务书的函数级旧问题复现，并新增真实浏览器切换、远端修订和视图重载验收。测试接线期间修正了模板名称基准、选择器标签及打开草稿按钮使用观察修订的条件。
4. T32.4 延迟应答回归最初发现新编辑后“发布新版本”仍启用；按提交内容确认后通过。
5. T32.5 延迟应答回归最初显示“过期客户”；请求归属和失败清理修复后通过。
6. 第一轮完整浏览器回归在旧 `.runtime-test/e2e` 数据中遇到历史客户规则造成的同优先级歧义。沿用既有 Playwright 配置，为每次运行使用 UUID 子目录并要求启动专属测试服务器；不删除旧数据，不调整业务匹配优先级来绕过歧义。最终回归改用该隔离目录。

现有大分块及第三方 `use client` 构建提示继续保留，构建成功。Compose CI 配置继续使用原工作流，本次机器没有 Docker 命令，未运行容器重启检查。

## T30.5 项目验收待办

以下需要真实项目输入，不计为 T32 本地编码失败，也不能用合成数据标记生产完成：

- 同项目至少两个客户的原始 Excel、脱敏合同/物料/检化验样本，以及业务确认的字段粒度、关联键、单位和正式结果筛选规则。
- 使用现有 `project:init`、`project:validate`、`project:probe` 和 `project:compare` 完成真实映射、只读接口探测及独立 BFR/业务基准对照。
- 通过既有授权器接口连接企业认证，提供稳定员工 `actorId` 和项目授权范围；未新增账号权限平台。
- 目标部署环境的 Compose/重启/备份恢复验证和 Office/WPS 首页、续页、末页、附页实印；选用 PDF 的项目还需自己的字体及版式验收。

本次交付保留既有 T30/T31 改动，不自动提交或推送 Git。

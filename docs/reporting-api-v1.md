# 本地统一生成服务

T14—T17 提供可运行的 Node.js 参考服务：前端只负责设计、字段绑定和展示；采集、视图计算、分页、逐页投影、Excel 导出和生成快照都由同一条服务端流程执行。

## 启动

需要 Node.js 22.6 或更新版本。在项目目录运行：

```sh
npm run serve:api
```

开发服务默认只监听 `127.0.0.1:5174`，数据保存在项目目录的 `var/brickbill-reporting/`。前端用 `npm run dev` 启动后，通过 Vite 代理访问同域 `/api`。开发服务预置 `dalipu-demo` 和 `general-mes-demo` 两个模拟项目，使用仓库内的脱敏样例数据，不连接 MES 数据库。完整部署配置见 [部署说明](../deploy/README.md)。

如需在部署环境启用项目令牌，将 `REPORTING_TOKENS_JSON` 配置为令牌到项目 ID 列表的映射，例如：

```json
{"project-a-token":["dalipu-demo"],"project-b-token":["general-mes-demo"]}
```

浏览器来源由 `REPORTING_ALLOWED_ORIGINS` 配置，使用逗号分隔，例如 `https://reports.example.com`。令牌模式下，服务在每个项目请求上检查令牌的项目授权；未配置令牌时只用于本机回环开发。生产部署还应接入企业现有身份认证、授权与审计体系。

## 前端流程

1. 导入客户 Excel，并在字段字典中绑定字段；多行字段应放入对应的明细区域。
2. 选择项目后，可从项目目录导入字段，或调用“视图试算”检查固定数据源与转换规则。
3. 将模板保存为服务端草稿并发布。发布过程校验页面配置，并把模板使用的视图和函数版本固定下来。
4. 可从项目模板目录打开指定发布版本或草稿；旧发布版本可以载入设计器并另存为新草稿。需要自动选模板时，为发布版本登记业务参数匹配规则。
5. 从项目字段目录生成打印参数表单，输入质保书打印号等业务键后预览。确认签发只更新该生成记录的签发元数据，读取的业务数据、分页、模板版本和 XLSX 文件均沿用预览快照。
6. 从历史质保书列表按业务键、模板、状态和日期查找单据，逐页查看、下载或重印；重印不重新采集业务表。

本地模拟项目的示例参数为 `dalipu-demo` 的 `{"printNo":"DEMO-CERT-001","productPart":"T"}`，或 `general-mes-demo` 的 `{"certificateRequestId":"MES-DEMO-9001"}`。

## HTTP 接口

所有路径以 `/api` 开头。最小调用示例：

`GET /api/health` 返回 `{"status":"ok"}`，供部署健康检查使用，不返回项目或令牌信息。

```http
GET /api/projects
GET /api/projects/dalipu-demo/catalog
POST /api/projects/dalipu-demo/views/preview
Content-Type: application/json

{"documentType":"qualityCertificate","businessKey":{"printNo":"DEMO-CERT-001","productPart":"T"}}
```

模板以 `PUT /projects/{projectId}/templates/{templateId}/draft` 保存，正文为 `{ "expectedRevision": 0, "template": { ... } }`。首次修订号从 0 开始；响应返回新的修订号。保存冲突返回 `REVISION_CONFLICT`。`GET /projects/{projectId}/templates` 列出该项目的模板；调用 `POST /projects/{projectId}/templates/{templateId}/publish` 发布不可变版本，可通过 `/versions` 查看历史并读取具体版本。

生成请求必须携带幂等键，可以明确指定已发布模板 ID 和版本，也可以按已登记规则自动匹配：

```http
POST /api/projects/dalipu-demo/generations
Content-Type: application/json

{
  "mode": "preview",
  "documentType": "qualityCertificate",
  "businessKey": { "printNo": "DEMO-CERT-001", "productPart": "T" },
  "templateRef": { "id": "template.customer-a", "version": 1 },
  "idempotencyKey": "demo-request-001"
}
```

服务返回生成标识、版本摘要、页计划和文件引用。预览确认签发调用 `POST /projects/{projectId}/generations/{generationId}/issue`；签发主体必须由身份授权器提供 `actorId`，请求体中的操作者字段不生效。接口幂等并检查原 XLSX 哈希，不会重新采集数据或导出文件。随后可调用：

- `GET /projects/{projectId}/generations/{generationId}` 查询状态和版本摘要。
- `GET /projects/{projectId}/generations/{generationId}/pages/{pageNumber}` 逐页读取工作表投影、图片资源和诊断。
- `GET /projects/{projectId}/generations/{generationId}/file` 下载已经保存的 XLSX。
- `GET /projects/{projectId}/generations?page=1&pageSize=25&q=打印号&templateId=模板ID&status=issue&from=ISO日期&to=ISO日期` 分页查询历史记录；每页最多 100 条。
- `POST /projects/{projectId}/generations/{generationId}/issue` 将预览快照确认为签发记录；需要认证器返回可信的操作者标识。
- `GET /projects/{projectId}/generations/{generationId}/file.pdf` 下载已开放项目的固定版式 PDF；生成或状态响应中的 `pdfUrl` 仅在可用时返回。首次生成后缓存 PDF，重印读取同一文件。
- `POST /projects/{projectId}/generations/{generationId}/reprint` 复用原快照并返回原文件引用。

为模板版本登记自动匹配规则：

```http
PUT /api/projects/dalipu-demo/templates/template.customer-a/versions/1/match-rule
Content-Type: application/json

{"documentType":"qualityCertificate","conditions":{"productPart":"T"},"priority":100}
```

自动匹配生成时传入 `"autoMatch": true` 并省略 `templateRef`。条件可引用项目业务参数目录中的键，以及 `templateMatchFields` 登记的 MES 采集字段；调用方只提交业务查询参数，不能传入或覆盖采集事实。先选择最高优先级，未命中返回 `DATA_NOT_FOUND`，最高优先级命中多个模板返回 `TEMPLATE_MATCH_AMBIGUOUS`。自动匹配结果的实际模板版本保存在快照中。

还提供字段目录、视图目录与试算、视图草稿和发布、模板草稿与历史、模板停用及项目内资源读写接口。错误响应包含稳定错误码和可用的项目、字段、记录、区域、页码或单元格上下文；未预期的服务异常不会把堆栈或连接信息发给浏览器。

## 快照与文件

### T29 设计目录与草稿试算

`GET /api/projects/{projectId}/designer-metadata` 复用项目鉴权，返回 `project`（数据集、字段和关系）、`catalog`、`views` 和 `functions`（函数描述及参数类型，不含执行代码）。前端用这些元数据生成选择器，不维护第二套字段目录。

原 `POST /api/projects/{projectId}/views/preview` 保持旧请求兼容，并支持以下可选参数：

- `definitions`：最多 100 个合法 `DataViewDefinition`，按视图 ID 覆盖已有规则；重复 ID 拒绝。依赖视图也可以一起传入。传入空数组表示当前模板没有修改的视图。
- `viewIds`：选择试算根视图，未传时试算合并后的全部视图。
- `limit` / `offset`：每个视图的主记录展示上限和起始位置；默认 100 / 0，上限 200。返回完整 `inputRecordCount` / `outputRecordCount`、`truncated`、实际执行版本和来源记录标识。每个视图所有嵌套子集合共享 `limit` 条预算，并提供 `childrenTruncated`。
- `template` / `pageDefinitionId`：传入当前未保存的完整模板包，可一起执行包校验及原分页规划器；模板必须属于当前项目。未指定页面时选取主页面，返回 `pagePlan`；支持既有固定、流式、联动及附页机制，仍受 500 页上限约束。

响应的 `mode` 为 `draft` 或 `published`，`definitions` 列出视图 ID、版本及配置来源。试算只读取当前业务数据，不保存任何视图、模板、生成快照或文件，也不签发。需要冻结结果时使用原生成预览接口；正式生成继续使用已发布模板固定的视图和函数版本。

字段错误返回视图及字段上下文；执行步骤的错误增加从 0 起始的 `stepIndex`，界面显示为第 `stepIndex + 1` 步。分页错误沿用区域/工作表定位信息。

### T30 固定版本试算、修订保护和模板匹配

视图试算可传 `versionMode: "draft"`（默认，允许传未保存的 `definitions`）或 `"pinned"`。固定模式传 `templateRef: { id, version }`，服务端从发布仓库读取正式模板包，再按其 `viewRefs` 精确加载视图版本；客户端不能替换固定包，也不能同时传草稿定义。单视图草稿试算只传目标 `viewIds`，不触发模板页面规划。模板发布和发布预检共用明细、附页条件、数据视图子项及确定性函数依赖解析。

`POST /api/projects/{projectId}/templates/{templateId}/preflight` 接收可选的 `expectedRevision`，只校验当前模板草稿并返回将锁定的视图/函数版本，不写入草稿或发布记录，不采集 MES。正式发布仍在仓库写锁中复核修订号，因此预检后若草稿改变，旧修订发布会返回 `REVISION_CONFLICT`。

视图和模板发布正文可传打开草稿时的 `expectedRevision`。服务端在仓库写锁内再次核对修订，不一致返回 `REVISION_CONFLICT`。省略该字段的既有客户端仍兼容，但新界面始终传入已读取的修订号。

`GET /api/projects` 的项目条目包含可选 `templateMatchFields`，例如 `{ "customer": { "label": "收货客户", "datasetId": "certificate.header", "fieldId": "cert.customer" } }`。项目加载时会验证数据集和字段存在，且匹配字段不能与请求业务参数重名。模板规则仍复用既有 `/versions/{version}/match-rule` 资源，条件可引用业务参数或这些登记字段。

`POST /api/projects/{projectId}/templates/match-preview` 检查最新已发布版本的规则和停用状态。先排除停用及已知业务参数不符合的候选，再按其引用的采集字段并集调用已登记适配器，并在响应增加 `matchFacts`，说明字段值、数据集/字段来源和参与行数；没有有效候选需要采集字段时不额外采集。生成请求不能传入采集字段值。必要字段缺少数据或值时返回定位错误；同一映射数据集多行值必须完全一致，否则返回 `AMBIGUOUS_SCOPE`。未使用字段为空不阻断本次匹配。规则仍复用既有 `/versions/{version}/match-rule` 读写资源，`DELETE` 用于移除规则；模板支持既有停用操作及对应恢复操作。

重复提交相同视图草稿的发布会复用已有内容版本，避免批量发布中断后重试产生重复版本；数据内容改变才新增发布版本。界面把本次发布的版本写回本地模板引用，保存模板草稿后再发布模板。刷新版本状态仅更新远端观察值，不会推进本地编辑的并发基准；生成幂等键在相同请求重试时保留，请求内容变化时更换。

一次生成采用“采集 → 固定视图版本 → 分页计划 → 逐页投影 → XLSX 导出 → 原子保存”的顺序。快照包含原始数据、视图结果、模板及规则版本、业务参数、页计划和 XLSX 的 SHA-256。模板草稿、发布版本、资源与快照按项目目录保存。生成文件、快照和逐页预览数据先写入临时目录，再整体提交。

### T31 采集数据参与模板匹配

项目注册可选 `templateMatchFields` 将模板条件键映射到数据集字段。字段映射是项目级白名单，不由浏览器传入；匹配值在适配器校验和转换后的 DatasetBundle 中读取。本次有效候选需要的映射字段，在数据集所有记录中都必须非空且归一化后值一致。不同值报 `AMBIGUOUS_SCOPE`；数据集为空报 `DATA_NOT_FOUND`；空值或超长值报 `VALUE_TYPE_ERROR`。字段 ID 不得与业务查询参数重复。

自动生成先检查当前规则是否引用采集字段。需要这些值时只调用一次 MES，随即完成模板匹配、页面规划和导出；只有业务参数条件的旧规则沿用原有匹配流程。`templateMatch` 是可选快照字段，因此之前保存的 v2 快照可以继续读取和重印。匹配试算在需要来源字段的候选规则存在时采集一次，并返回 `matchFacts`；纯业务参数规则不会额外读取 MES。

相同项目及相同幂等键、相同请求参数会返回既有生成记录；相同幂等键不能用于另一组参数。重新采集必须使用新幂等键。自动匹配如需登记的采集字段，会先采集一次，再使用同一数据包完成匹配和生成。快照记录匹配条件、优先级、采集字段来源和值及固定模板版本；紧凑历史索引保留同一匹配依据。签发仅更新生成记录中的状态、认证操作者和时间，不改写 GenerationSnapshot 或 XLSX。签发元数据与快照记录一起原子保存；当前本地仓库的并发签发锁覆盖单服务进程。重印始终返回已存文件，即使原模板后来停用也可重印。

### T32 匹配与编辑一致性

匹配试算和自动生成均在一次请求内捕获候选的模板版本、条件、优先级和停用状态，按这批候选计算必要字段并完成最终求值；等待采集期间不会重新扫描规则来改变本次选择。后续新请求使用当时的新规则。生成仍保留原有停用检查，发现所选模板已停用时明确失败，不切换到其他模板。此约定是请求内的一致性，不提供跨进程事务。

候选响应保留 `matches` 和 `mismatchedFields`，增加 `pendingFields` 及 `status`（`disabled`、`mismatch`、`pendingFacts`、`matched`）。尚未采集的字段只进入 `pendingFields`，不冒充已比较失败。必要事实缺少或冲突时整个请求失败，即使存在低优先级通用模板也不会静默降级。

设计器将加载会话、项目、模板及实际内容与并发修订基准绑定。选择其他模板或刷新列表只更新观察状态；明确打开远端草稿才载入内容和对应基准。独立视图内容与远端草稿不同的时候不能只提升基准；可显式选择“重新载入服务端视图草稿（丢弃本地视图修改）”后保存。

保存请求只确认请求开始时提交的内容；等待期间产生的新修改继续保持未保存，发布/预检会被阻止。批量视图发布固定本次定义集合，中途失败可沿用已发布内容版本重试，全部成功后才更新模板完整引用。编辑内容或上下文变化时不应用过期发布结果。

匹配诊断随项目、单据类型、参数或模板选择变化而失效；迟到结果与迟到错误不会回填新上下文。新试算开始时清理旧结果，失败不保留上一笔客户事实。快照缺少 `templateMatch` 时界面显示“未记录”，不会依据当前规则推断历史原因。已生成单据的签发和重印仍使用原快照及原 XLSX。

## Excel 和宿主边界

固定版式 PDF 的渲染环境、字体和图片检查以及项目单独验收流程见 [PDF 输出说明](pdf-output.md)。流式模板仍使用现有预览与 XLSX 输出。

每个逐页投影写入可见工作表，并在输出后重新读取 XLSX，检查工作表、单元格、合并、行列尺寸、图片锚点和打印区域。可能因分页移动的公式当前会以 `UNSUPPORTED_FORMULA_LAYOUT` 明确拒绝。自定义纸张的尺寸码由 Excel / Office 安装环境决定；程序回读不等于完成了 Office 打印预览或实印校准。

宿主保存协议 v1 保持原样。启动时通过 v1 的能力询问协商 v2；只支持 v1 的宿主不会收到包级或生成文件 v2 消息，前端会下载 XLSX。支持 v2 的宿主可接收完整模板包或生成文件。参考实现仍有单次宿主传输大小限制，需要更大文件时应由宿主实现分块传输。

生产项目只需替换 `server/runtime.ts` 中的模拟适配器，使用同一 `ProjectAdapter` 接口读取 MES 已落地的合同、物料、检化验表。项目、字段映射和视图定义放在项目适配层；公共分页、投影与导出服务不按客户或项目名称分支。

参考服务限制单个 JSON 请求体不超过 60 MiB、模板最多 50 个工作表 / 100 个页面定义 / 100 万个已登记单元格，单次输出最多 500 页 / 500 万个投影单元格。默认 XLSX 文件上限 50 MiB、快照上限 80 MiB，可通过 `REPORTING_MAX_OUTPUT_BYTES` 和 `REPORTING_MAX_SNAPSHOT_BYTES` 调整。

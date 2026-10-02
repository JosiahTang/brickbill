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
4. 如需自动选模板，为发布版本登记匹配规则，指定单据类型、项目已登记的业务参数条件和优先级。输入业务单号后选择明确版本或自动匹配，再预览或正式生成。
5. 逐页查看服务端生成的结果；下载、宿主保存与重印使用该次生成的 XLSX。重印读取已保存文件，不重新采集业务表。

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

模板以 `PUT /projects/{projectId}/templates/{templateId}/draft` 保存，正文为 `{ "expectedRevision": 0, "template": { ... } }`。首次修订号从 0 开始；响应返回新的修订号。保存冲突返回 `REVISION_CONFLICT`。调用 `POST /projects/{projectId}/templates/{templateId}/publish` 发布不可变版本，可通过 `/versions` 查看历史。

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

服务返回生成标识、版本摘要、页计划和文件引用。随后可调用：

- `GET /projects/{projectId}/generations/{generationId}` 查询状态和版本摘要。
- `GET /projects/{projectId}/generations/{generationId}/pages/{pageNumber}` 逐页读取工作表投影、图片资源和诊断。
- `GET /projects/{projectId}/generations/{generationId}/file` 下载已经保存的 XLSX。
- `GET /projects/{projectId}/generations/{generationId}/file.pdf` 下载已开放项目的固定版式 PDF；生成或状态响应中的 `pdfUrl` 仅在可用时返回。首次生成后缓存 PDF，重印读取同一文件。
- `POST /projects/{projectId}/generations/{generationId}/reprint` 复用原快照并返回原文件引用。

为模板版本登记自动匹配规则：

```http
PUT /api/projects/dalipu-demo/templates/template.customer-a/versions/1/match-rule
Content-Type: application/json

{"documentType":"qualityCertificate","conditions":{"productPart":"T"},"priority":100}
```

自动匹配生成时传入 `"autoMatch": true` 并省略 `templateRef`。条件只能引用项目业务参数目录中登记的键；先选择最高优先级，未命中返回 `DATA_NOT_FOUND`，最高优先级命中多个模板返回 `TEMPLATE_MATCH_AMBIGUOUS`。自动匹配结果的实际模板版本保存在快照中。

还提供字段目录、视图目录与试算、视图草稿和发布、模板草稿与历史、模板停用及项目内资源读写接口。错误响应包含稳定错误码和可用的项目、字段、记录、区域、页码或单元格上下文；未预期的服务异常不会把堆栈或连接信息发给浏览器。

## 快照与文件

一次生成采用“采集 → 固定视图版本 → 分页计划 → 逐页投影 → XLSX 导出 → 原子保存”的顺序。快照包含原始数据、视图结果、模板及规则版本、业务参数、页计划和 XLSX 的 SHA-256。模板草稿、发布版本、资源与快照按项目目录保存。生成文件、快照和逐页预览数据先写入临时目录，再整体提交。

相同项目及相同幂等键、相同请求参数会返回既有生成记录；相同幂等键不能用于另一组参数。重新采集必须使用新幂等键。重印始终返回已存文件，即使原模板后来停用也可重印。

## Excel 和宿主边界

固定版式 PDF 的渲染环境、字体和图片检查以及项目单独验收流程见 [PDF 输出说明](pdf-output.md)。流式模板仍使用现有预览与 XLSX 输出。

每个逐页投影写入可见工作表，并在输出后重新读取 XLSX，检查工作表、单元格、合并、行列尺寸、图片锚点和打印区域。可能因分页移动的公式当前会以 `UNSUPPORTED_FORMULA_LAYOUT` 明确拒绝。自定义纸张的尺寸码由 Excel / Office 安装环境决定；程序回读不等于完成了 Office 打印预览或实印校准。

宿主保存协议 v1 保持原样。启动时通过 v1 的能力询问协商 v2；只支持 v1 的宿主不会收到包级或生成文件 v2 消息，前端会下载 XLSX。支持 v2 的宿主可接收完整模板包或生成文件。参考实现仍有单次宿主传输大小限制，需要更大文件时应由宿主实现分块传输。

生产项目只需替换 `server/runtime.ts` 中的模拟适配器，使用同一 `ProjectAdapter` 接口读取 MES 已落地的合同、物料、检化验表。项目、字段映射和视图定义放在项目适配层；公共分页、投影与导出服务不按客户或项目名称分支。

参考服务限制单个 JSON 请求体不超过 60 MiB、模板最多 50 个工作表 / 100 个页面定义 / 100 万个已登记单元格，单次输出最多 500 页 / 500 万个投影单元格。默认 XLSX 文件上限 50 MiB、快照上限 80 MiB，可通过 `REPORTING_MAX_OUTPUT_BYTES` 和 `REPORTING_MAX_SNAPSHOT_BYTES` 调整。

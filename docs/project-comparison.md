# 项目数据对照

`project:compare` 对照已确认的业务基准和本工具产生的数据视图。用例基准是独立维护的 JSON；不要从正在验收的同一轮程序输出自动生成预期值。仓库里的 [Dalipu 合成基准](../tests/fixtures/project-comparison/dalipu-synthetic.json) 和 [通用 MES 合成基准](../tests/fixtures/project-comparison/general-mes-synthetic.json) 只用于开发回归，不代表客户业务结果已确认。

## 执行方式

离线模式使用套件用例中的 `sourceSnapshot`，不访问 MES，也不需要令牌：

```powershell
npm run project:compare -- --mode offline --config config/projects.json --suite tests/fixtures/project-comparison/dalipu-synthetic.json --output output/dalipu-comparison.json
```

在线模式使用注册配置中的只读源地址和现有令牌环境变量：

```powershell
$env:MES_SOURCE_TOKEN = '从密钥管理系统注入的令牌'
npm run project:compare -- --mode online --config config/projects.json --suite acceptance/dalipu/cases.json --output output/dalipu-comparison.json
```

offline/online 模式都会调用项目映射和视图引擎。命令处理套件中的全部用例，保存 JSON 报告；若项目加载、采集或任一基准对照失败，仍保存报告并返回非零退出码。

## 已生成质保书验收

`snapshot` 模式直接读取指定数据目录中的已保存生成快照和 XLSX，不初始化 MES adapter、不重新采集，也不写入生成仓库。每个用例须提供 `generation` 预期；用 `generationId` 锁定生成记录，用 `templateRef`、`pageCount`、`pageTypes`、`pages` 和 `xlsx` 声明由业务确认的基准。示例：

```powershell
npm run project:compare -- --mode snapshot --data-dir var/brickbill-reporting --suite acceptance/customer-a/output.json --output output/customer-a-output.json
```

页面断言按页码、页面类型、区域、视图及业务记录键顺序核对。区域列表中的记录键按当前页分配顺序比较；设置 `exactAllocations: true` 后，该页还须精确包含所列的全部区域分配。重复表头或普通模板标签不属于分页记录分配，不会被当成重复业务记录。

`xlsx` 可逐项核对工作表顺序、单元格标量值/类型/数字格式、每张表的完整合并区列表、图片数量和锚点，以及方向、纸张代码和打印区域。快照模式会校验 XLSX 的字节数和 SHA-256，并在用例报告中保留文件名、哈希和字节数。报告包含 generationId、模板版本、页码、区域、视图、记录键、工作表和 A1 地址；缺快照、缺文件、内容损坏或任一断言失败都会使命令返回非零退出码。

示例用例片段（将 `generationId` 替换成实际生成记录标识；预期值应由业务基准维护，不要从被验收结果自动导出）：

```json
{
  "caseId": "customer-a-multipage-certificate",
  "documentType": "qualityCertificate",
  "businessKey": { "printNo": "QC-2026-001", "productPart": "T" },
  "assertions": [],
  "generation": {
    "generationId": "gen-approved-output-id",
    "templateRef": { "packageId": "customer-a-certificate", "revision": 3 },
    "pageCount": 3,
    "pageTypes": ["main", "main", "appendix"],
    "pages": [
      {
        "pageNumber": 1,
        "pageType": "main",
        "allocations": [
          {
            "regionId": "region.material",
            "viewId": "view.certificate.material-print",
            "keyFields": ["material.lineId"],
            "recordKeys": [{ "material.lineId": "LINE-01" }]
          }
        ]
      },
      {
        "pageNumber": 2,
        "pageType": "main",
        "allocations": [
          {
            "regionId": "region.material",
            "viewId": "view.certificate.material-print",
            "keyFields": ["material.lineId"],
            "recordKeys": [{ "material.lineId": "LINE-02" }]
          }
        ]
      },
      {
        "pageNumber": 3,
        "pageType": "appendix",
        "allocations": [
          {
            "regionId": "region.hardness",
            "viewId": "view.certificate.hardness-print",
            "keyFields": ["hardness.sample.sampleId"],
            "recordKeys": [{ "hardness.sample.sampleId": "HS-01" }]
          }
        ]
      }
    ],
    "xlsx": {
      "worksheets": ["质保书_001", "质保书_002", "硬度检验附页_003"],
      "cells": [{ "sheet": "质保书_001", "address": "A1", "value": "客户 A 质保书", "type": "string" }],
      "merges": [{ "sheet": "质保书_001", "ranges": ["A1:P2"] }],
      "images": [{ "sheet": "质保书_001", "count": 1, "anchors": [{ "tl": { "col": 12, "row": 0 }, "br": { "col": 15, "row": 3 } }] }],
      "pageSetup": [{ "sheet": "质保书_001", "orientation": "landscape", "paperSize": 8, "printArea": "A1:P44" }]
    }
  }
}
```

`pages` 若提供，则按完整页序声明且数量须与 `pageCount` 一致；各页至少列出一个需验收的区域。需要精确检查整页所有区域时，对该页设置 `exactAllocations: true`。支持纯 generation 用例，因此 `assertions` 可以为空；offline/online 数据对照仍要求每个用例含数据断言。

## 套件结构

套件顶层包含 `suiteVersion: 1` 或 `2`、唯一的 `suiteId`、`projectId` 和 `cases`。v1 保持原有数据、数量和锚点对照语义；v2 增加下述可选图片内容断言。未知版本拒绝。可选 baseline 字段记录基准来源；客户验收须填写 sourceKind=customer、referenceId、approvedBy 和 approvedAt。project:compare 会在报告中保留基准来源，project:acceptance 对 customer 清单拒绝缺少业务批准信息的对照报告。旧套件不含 baseline 时按 unclassified 兼容，但不能用它完成客户项目验收。每个用例指定 `caseId`、`documentType`、`businessKey`、一组 `assertions`；离线用例额外指定相对套件文件的 `sourceSnapshot` 路径。每条断言指向一个 `dataset` 或 `view`：

```json
{
  "scope": "view",
  "targetId": "view.certificate.material-print",
  "expectedCount": 2,
  "keyFields": ["material.lineId"],
  "expectedOrder": [{ "material.lineId": "LINE-01" }, { "material.lineId": "LINE-02" }],
  "records": [
    {
      "key": { "material.lineId": "LINE-01" },
      "values": { "material.pieces": 5, "material.weight": 3.531 }
    },
    {
      "key": { "material.lineId": "LINE-02" },
      "values": { "material.pieces": 6, "material.weight": 4.244 }
    }
  ],
  "numericTolerance": 0.001
}
```

`expectedCount` 核对完整结果条数；填写 `records` 时，每条记录按 `keyFields` 匹配，并核对列出的字段值。默认要求记录集合精确一致，因而会报告缺失和多余记录；`exactRecordSet: false` 可用于只核对部分关键记录。`expectedOrder` 核对完整输出顺序。`numericTolerance` 是数字字段的绝对误差范围，不作用于文本、日期、布尔值或空值。

报告按用例、目标、记录键和字段列出差异。值不一致报告会包含基准值和实际值，因此在线生产对照应将报告写入受控目录；不要将未脱敏的报告提交到仓库。用例只比较显式声明的字段，需覆盖业务要求的全部关键值、结果筛选、数量汇总和排序。

真实项目验收还需录入经业务确认的 BFR/MES 结果，覆盖单页、多页和特殊附页。字段映射、记录粒度、单位、正式结果筛选和关联键必须由真实接口及脱敏样本确认；合成回归通过不能替代这一步。

### v2 图片内容断言

在 `suiteVersion: 2` 的 `generation.xlsx.images[]` 中，可增加 `contentSha256: string[]`。长度必须等于该工作表的 `count`，每项为 64 位小写十六进制 SHA-256；顺序与 ExcelJS 回读的图片位置顺序及 `anchors` 一致。摘要针对每个位置引用的 PNG/JPEG/GIF **编码文件字节**，base64 先解码；不比较资源 ID、ZIP 条目名或整份 XLSX 摘要，也不把视觉相同但编码不同的文件自动认作相同。共享资源的多个位置逐项声明。摘要须来自独立批准的基准，不能从本次被验收输出反向生成。

该断言只在 `project:compare --mode snapshot` 中执行。offline/online 请求图片内容断言会产生失败报告和非零退出；不能只比较数据却报告图片通过。v1 套件夹带 `contentSha256` 会被拒绝，新版继续读取没有该字段的 v1；旧版软件会拒绝 v2，历史报告不会被补认已检查图片内容。

比较报告保留 `reportVersion: 1`，增加来源字段 `suiteVersion` 和 `imageContentChecks: { requested, checked, passed }`，后者记录请求数量、实际读取并计算摘要数量及匹配数量；每个输出比较也含同样计数。旧报告缺少这些字段表示没有该项证据，不能按通过推断。数量或锚点正确、但图片内容错误仍以 `IMAGE_CONTENT_MISMATCH` 失败；缺失/损坏资源以 `IMAGE_CONTENT_INVALID` 失败。两种合法 Excel 锚点 `tl + br`、`tl + ext` 均可比较，无效锚点报告 `IMAGE_ANCHOR_INVALID`。

模板包 v2、文档 v1、图片布局 v1 和部署证据 v2/v3/v4 保持原有版本。本次套件版本只用于独立输出基准，不替代实际 Office/WPS 实印验收。

### 预期业务错误

offline/online 套件可用 expectedError 声明在采集或视图计算阶段应发生的确定性业务拒绝。仅接受 DATA_NOT_FOUND、DUPLICATE_KEY、RELATION_CARDINALITY_ERROR、FIELD_NOT_FOUND、VALUE_TYPE_ERROR、VIEW_INVALID，并可指定数据集/字段/视图位置。源超时、源不可用、配置及网络错误不能声明为预期业务结果；匹配失败也不会吞掉这些运行故障。

```json
{
  "caseId": "invalid-required-material-value",
  "documentType": "qualityCertificate",
  "businessKey": { "printNo": "QC-001", "productPart": "T" },
  "sourceSnapshot": "invalid-source.json",
  "assertions": [],
  "expectedError": {
    "code": "VALUE_TYPE_ERROR",
    "stage": "collect",
    "context": { "datasetId": "material.lines", "fieldId": "material.length" }
  }
}
```

如果未出现预期错误，或实际错误的阶段、错误码、定位不符，用例失败。expectedError 与正常数据/生成断言互斥。

### 项目验收证据汇总

命令 npm run project:acceptance -- --manifest acceptance/project-a/acceptance.json --output output/project-a-acceptance.json 只汇总已有报告和人工签字记录，不重新采集或生成。版本 1 保持六类证据格式以读取历史清单；版本 2 增加数据/输出分立对照和报告文件哈希，适用于新的客户验收。sourceKind 必须是 customer 或 synthetic：

```json
{
  "acceptanceVersion": 1,
  "acceptanceId": "project-a-pilot",
  "projectId": "project-a",
  "sourceKind": "customer",
  "evidence": [
    { "kind": "validate", "path": "project-validate.json" },
    { "kind": "probe", "path": "mes-probe.json" },
    { "kind": "comparison", "path": "business-comparison.json" },
    { "kind": "deployment", "path": "restore-smoke.json" },
    { "kind": "identity", "path": "identity-acceptance.json" },
    { "kind": "print", "path": "office-print-approval.json" }
  ]
}
```

新客户项目使用版本 2，并为每份证据 JSON 固定 SHA-256。以下哈希为占位值，实际清单必须填写对应文件的真实摘要：

```json
{
  "acceptanceVersion": 2,
  "acceptanceId": "customer-a-pilot",
  "projectId": "customer-a",
  "sourceKind": "customer",
  "evidence": [
    { "kind": "validate", "path": "project-validate.json", "sha256": "<64位十六进制摘要>" },
    { "kind": "probe", "path": "mes-probe.json", "sha256": "<64位十六进制摘要>" },
    { "kind": "data-comparison", "path": "business-data-comparison.json", "sha256": "<64位十六进制摘要>" },
    { "kind": "output-comparison", "path": "generation-output-comparison.json", "sha256": "<64位十六进制摘要>" },
    { "kind": "deployment", "path": "deployment-restore.json", "sha256": "<64位十六进制摘要>" },
    { "kind": "identity", "path": "identity-acceptance.json", "sha256": "<64位十六进制摘要>" },
    { "kind": "print", "path": "office-print-approval.json", "sha256": "<64位十六进制摘要>" }
  ]
}
```

文件路径相对清单所在目录。版本 1 客户清单仍可读取历史 `comparison` 证据，但由于不能证明生成快照/XLSX 对照，会标为 `pending`，补齐后升级到版本 2；版本 1 合成清单仍可作为模拟记录读取。版本 2 的七类证据为 `validate`、`probe`、`data-comparison`、`output-comparison`、`deployment`、`identity`、`print`。每个清单条目都要写对应证据 JSON 文件的 SHA-256；汇总时重新计算，不一致即失败。数据对照必须来自 offline/online 报告，输出对照必须来自 snapshot 报告，并且逐条检查 generationId、固定模板版本、页数、XLSX 哈希和比较状态。客户数据对照和输出对照都要带已批准的独立基准，且提供 `sourceKind=customer`、`referenceId`、`approvedBy` 和可解析的 `approvedAt`。

版本 2 的 `print.artifacts` 使用对象记录样张相对路径、样张 SHA-256、generationId、模板 packageId/revision 及对应生成 XLSX 的 SHA-256。汇总器会校验样张字节，并确认这些标识与通过的 output-comparison 同一条记录。部署证据同时记录服务重启结果和恢复到空目录/空卷后的 generationId、页数及 SHA-256；只有重启而没有独立恢复材料时状态为 `pending`。历史版本 1 的字符串样张仍可读，但不能让版本 1 客户清单通过完整验收。

Compose 烟测的 `compose-smoke-result.json` 在未要求 PDF 时使用 `deploymentEvidenceVersion: 3`，记录唯一源/恢复 Compose 项目、备份 SHA-256、恢复目标为空卷、generationId、页数、XLSX SHA-256，以及固定模板、视图、函数定义和资源摘要在恢复前后的对照。要求并验证 PDF 时使用版本 4，另含 `pdfAvailable`、`pdfSha256`、`pdfByteLength` 和对应的 `restorePdfAvailable`、`restorePdfSha256`、`restorePdfByteLength`，PDF 摘要或长度前后不一致时失败。烟测还会在每次重印前后分别下载并比较实际 PDF 文件。单独的 `backup-evidence.json` 仍使用 `backupEvidenceVersion: 1`，验收清单仍使用 `acceptanceVersion: 2`。

历史部署证据 v2/v3 保持原语义可读，不被解释为已验证 PDF；v2 不补认依赖完整性检查。未标版本的历史记录维持既有读取规则，只有重启的记录仍为 `pending`。v3/v4 缺少依赖摘要或前后摘要不一致时失败，v4 还要求 PDF 有效且恢复一致，明确不支持的版本号会失败。T40 没有新增证据版本，也不改变旧格式兼容行为。

版本化部署证据还必须给出相对路径 `backupArchivePath`。汇总器会在部署证据所在目录内流式读取归档并重算 `backupSha256`；归档缺失、哈希不匹配或路径/符号链接越出证据目录都会失败。把部署证据用于 project:acceptance 时，需与归档一起保存到该证据目录。

汇总报告记录检查时的 Git HEAD、工作区是否有改动以及每份证据的 SHA-256，不复制源样本、令牌或报告正文。合成证据最多标为 `simulation-only`；证据缺失为 `pending`，错误证据为 `failed`，只有客户版所需证据齐备才可汇总为 `passed`。汇总器检查证据结构、内容关联和状态声明；它不替代业务审核，也不执行真实 MES、Docker 恢复或 Office/WPS 打印。

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

套件顶层包含 `suiteVersion: 1`、唯一的 `suiteId`、`projectId` 和 `cases`。每个用例指定 `caseId`、`documentType`、`businessKey`、一组 `assertions`；离线用例额外指定相对套件文件的 `sourceSnapshot` 路径。每条断言指向一个 `dataset` 或 `view`：

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

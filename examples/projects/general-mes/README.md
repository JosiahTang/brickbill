# 第二项目：通用 MES 模拟源

业务入口为 `certificateRequestId`，物理集合分别是 `order_summary`、`order_requirements`、`shipment_coils`、`lab_chemistry`、`lab_mechanical`、`lab_hardness`、`process_checks`；列名采用下划线风格，与达力普的业务键、表名和字段命名都不同。适配定义在 `src/core/adapters/example-projects.ts`，两套模板在 `index.ts`，打印视图使用通用投影 `quality-views.ts`。

`tests/reporting-projects.test.mjs` 使用 `tests/fixtures/reporting/general-mes/source.json` 验证这两套模板可发布并按业务单号生成。只做模拟复用验证，尚未接入第二个真实项目。新项目不应复制公共采集、视图、分页或导出代码；按 `docs/project-integration.md` 注册自己的只读数据接口即可。

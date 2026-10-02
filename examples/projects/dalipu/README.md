# 达力普参考项目：模拟接入记录

本目录的两套模板定义见 `index.ts`，共同使用 `quality-templates.ts` 的 Excel 导入、绑定和分页配置路径。`dalipu-certificate-v1` 按物料、化学、力学、检验排列；`dalipu-customer-v1` 更换区块顺序和容量。二者读取同一套源字段映射，未复制采集或分页后台。模板工作簿由测试代码合成，用于验证功能，**不是客户原始 Excel，也不是 BFR 版式的复刻**。

## 参考代码与已确认线索

参考目录：`D:\Workspace_BS\DLP_CODE_SCENE\server-qm\Server\QMTCRG\p_qmtcrg_4560\`。仅作只读分析，没有修改旧代码或执行旧分页写回。

| 来源 | 已看到的键与用途 | 新模型 |
| --- | --- | --- |
| `qmtcrg01_print.cpp` / `TQMTCRG01` | `CERTI_PRINT_NO` + `TUBE_COUP_FLAG` 查证书头；`SALE_ORDER_SUB_NO` 关联合同要求 | `certificate.header`，按打印号 + 产品类别一行 |
| `qmtcrg02_print_tube.cpp` / `TQMTCRG02` | `HEAT_NO`、`SAMPLE_LOT_NO`、`MAT_NUM`、`TOTAL_LEN` 等组织物料与发货 | `material.lines`，按打印号 + 产品类别 + 明细行键 |
| `qmtcrgq0_print.cpp` / `TQMTCRGQ0` | 化学成分列 `ELM_VALUE1` 等，旧 SQL 同 `TQMTCRG02` 按炉号连接 | `quality.chemistry-results`，保持独立记录粒度，禁止与物料直接多对多拼表 |
| `qmtcrg02_sub_print2.cpp` / `TQMTCRG02` | 硬度按象限、位置、测点取值；`TQMTORGC1.TEST_NUM`、`TQMTORGPG.HARD_NUM/HARD_SPOT_NUM` 来自合同要求 | `quality.hardness-results`，通过现有 `hardness-by-sample` 函数组织 |
| `TQMTORG01`、`TQMTORGC1`、`TQMTORGPG` | 合同及检验配置与 `SALE_ORDER_SUB_NO` 相关 | `contract.info` 及采集时冻结的规则值 |

当前模拟映射在 `src/core/adapters/example-projects.ts`。已经与上述代码核对的物理列包括 `CERTI_PRINT_NO`、`TUBE_COUP_FLAG`、`SALE_ORDER_SUB_NO`、`HEAT_NO`、`SAMPLE_LOT_NO`、`MAT_NUM`、`TOTAL_LEN`、`YS_TC`、`TS_TC`、`YIELD_RATE_TC`、`EL_TC`。其余驼峰列名只是脱敏样本别名，不能视为真实库表字段。正式接入需由 MES 提供只读接口或脱敏快照，并逐项确认表字段、数量/重量单位、正式检验结果选择和合同配置版本。

## 模拟对照结果与实物差异

`tests/reporting-projects.test.mjs` 覆盖单号生成、42 条物料与多集合不等长分页、硬度附页、记录无遗漏与顺序，以及两套布局。`npm run benchmark:reporting` 可重测本机基线。样本均来自 `tests/fixtures/reporting/`；没有客户原始 Excel、真实单页/多页/特殊附页的 BFR 人工确认结果、签章图片和目标办公软件实印，因此 BFR 字段/页码一致性与生产验收**待核对**。特别要核对旧代码按炉号连接 `TQMTCRGQ0` 时是否有多行放大，以及 T/J 类别下的显示规则。

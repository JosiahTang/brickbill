# 通用报表核心 T01 至 T06

状态：T01 至 T06 的首版代码已实现。模拟项目采集、通用视图、字段目录、硬度函数和旧模板迁移已加入自动化验证；完整构建验证通过。没有 MES 生产接口及脱敏真实质保书数据，真实映射和业务规则仍待项目验收。

通用核心以项目登记的数据契约为边界：项目适配器按业务单号读取源数据并映射为稳定数据集，字段目录按稳定标识描述来源和粒度，视图用受控操作形成打印数据，特殊计算通过有版本的公共函数执行。预览和模板模块可以直接调用这些 TypeScript 接口；HTTP 适配器可以对接项目已有的只读数据接口。

## 代码位置

| 文件 | 职责 |
| --- | --- |
| `src/core/contracts/types.ts` | 项目、数据包、字段目录、数据视图、模板包、页计划和快照类型 |
| `schemas/v2/reporting-contract.schema.json` | JSON Schema v2，含项目、源响应、视图、模板包、分页及快照定义 |
| `src/core/contracts/validate.ts` | JSON Schema 校验及项目主键、关系键检查 |
| `src/core/contracts/migrate.ts` | 将 v0.2 单工作表 JSON 模板迁移为带 `legacy-path` 标记的模板包 |
| `src/core/adapters/project-adapter.ts` | 字段映射、复合键、类型转换、内存及 HTTP 数据适配器 |
| `src/core/catalog/catalog.ts` | 项目字段目录、受控视图字段和数据包校验 |
| `src/core/views/engine.ts` | 筛选、排序、投影、分组、聚合、透视、一对一查找和父子视图 |
| `src/core/functions/registry.ts` | 按函数名和版本注册确定性业务函数 |
| `src/core/functions/hardness.ts` | 按试样、象限、位置及测点组织已批准硬度结果 |
| `src/core/adapters/example-projects.ts` | 达力普形态项目、第二项目的标准契约、映射及视图样例 |
| `src/core/adapters/demo-context.ts` | 使用合成 fixture 创建两个内存适配器，单独导入即可运行样例流程 |
| `tests/fixtures/reporting/` | 两种源字段命名、批量分页压力数据、生成脚本及预期集合粒度说明 |

## 运行核心流程

`src/core/index.ts` 是不含演示记录的公共入口。演示样例独立放在 `src/core/adapters/demo-context.ts`，生产调用不应依赖 `tests/fixtures/`。

```ts
import { DataViewEngine } from './core/index.ts';
import { createReportingDemoContext as createDemo } from './core/adapters/demo-context.ts';

const demo = createDemo();
const { project, catalog, views, functions, adapter, request } = demo.dalipu;
const bundle = await adapter.collect(request);
const engine = new DataViewEngine({ project, catalog: catalog.fields, views, functions });
const certificate = engine.execute('view.certificate-header', bundle);
```

这里展示的是调用顺序，不代表已连接达力普的数据库或真实接口。生产项目应使用登记的项目定义、映射和 `HttpProjectAdapter`，由受信服务配置只读 HTTPS 接口和认证信息。

## 统一数据和字段

`DatasetBundle` 分开保留合同、物料、化学成分、力学结果、硬度测点和其他检验结果。每个记录以项目声明的有序复合主键生成长度前缀 ID；缺主键、重复键、未知字段、错误类型和项目不匹配都会停止采集。适配器不会把物料行与成分、力学两组一对多数据直接联接。

项目业务字段使用稳定且有业务含义的 `fieldId`。同一字段若属于不同粒度，应使用不同字段标识，例如 `material.heatNo` 和 `chem.heatNo`。目录另外记录字段类型、可空状态、粒度、单位以及数据集或视图来源。标签和数字显示格式不决定源字段。

两个演示项目用相同的业务字段与视图定义，但有不同的业务查询键、源集合名称和列名。达力普演示映射使用已在参考代码中见到的打印号、类别、分项合同号、客户名称、物料数量、重量和部分力学列名；其余数据源列是样例字段或查询别名。必须根据实际项目表结构修订，并经业务核对后才能发布。

## 数据视图行为

视图步骤有固定的类型和顺序，不执行 SQL、JavaScript 或用户源码。数值比较和汇总要求有效数字；分组聚合输出值为空时保留 `null`；透视必须列出所有期望列值。透视键出现多个值时拒绝输出，或要求模板明确配置数值汇总规则。一对一查找从已登记关系取值，并检查不能匹配到多条子记录。

`children` 将物料、化学、力学、硬度和工艺检验分别挂在质保书头记录上。每个明细仍是独立集合，沿完整、类型一致的复合键关联。`ViewRecord.sourceRecordIds` 保留参与输出的源记录标识。业务分页规则由 T12 负责，不在本轮的数据视图中计算。

## 硬度公共函数

函数 `hardness-by-sample@1.0.0` 先按每个试样和试验类型分组，再将象限、外侧 / 中部 / 内侧位置和测点输出为固定稳定字段；每组输出四个象限、三种位置、四个测点及各位置平均值字段。函数要求显式传入 `approvedOnly`。生产示例传入 `true`，并要求每条源结果带正式审核标记。相同格位出现多条已批准结果会返回歧义错误，不自动选取一条。

当前平均值按同一象限和位置下实际存在的点作算术平均，未提供的点保持空值。生产使用前须与达力普质量规则确认是否使用该方式、精度和舍入；需要不同算法时增加新版本函数，不覆盖已发布的旧版本。

## 当前边界

T01 至 T06 提供公共类型、Schema、适配接口、视图执行器和函数注册表。项目连接由调用方提供只读 HTTPS 端点；此处还没有独立部署的 REST 服务、认证中间件、视图管理界面或数据库持久层，这些分别属于 T09、T16 和 T17。字段目录及视图目前是代码配置，模板设计器也尚未迁移到稳定 `fieldId`。

自动化验证覆盖版本及关系契约错误、v0.2 模板迁移、两个项目的采集与数据视图、独立明细记录、硬度均值和歧义检查、重复主键及批量数据。它证明演示映射可走通公共核心，不证明真实项目字段和质量判定规则已核准。T12 分页引擎尚未实现，因此批量 fixture 只验证可供后续分页使用的数据组织和数量，不验证页数。

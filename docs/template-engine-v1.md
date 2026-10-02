# 模板包与分页引擎 T07—T13

日期：2026-10-02。本文记录 T07—T13 首版代码的使用边界。完整开发任务和后续依赖见 [programming-tasks-v1.md](programming-tasks-v1.md)。

## 已实现的工作流

导入 Excel 时，工具把每个可见工作表变成独立文档，以稳定 `worksheetId` 标识，并在模板包级只保存一份原始 XLSX。保存或重新打开时，工作表顺序、名称、样式、合并区域、图片和嵌入的模板元数据一起保留。旧版单工作表 JSON 仍可载入。浏览器草稿支持模板包形式；字段新增、编辑和删除会在所有工作表共用的字典中校验。多表中已用字段不能删除，字段路径作为共享别名保持稳定，来源和显示属性可编辑。

字段来源支持项目数据集、数据视图、常量、运行参数、页面系统字段及旧版路径；类型包含文本、数字、日期和布尔值。JSON 自动推断会遍历异构数组和嵌套对象，合并同一字段路径的类型信息，不覆盖已有字典定义。视图页面可保存有 Schema 校验的草稿，筛选和排序可用控件编辑，分组、投影、透视及已注册函数使用受控操作 JSON，不执行用户脚本。

页面配置定义主表、续页或附页，选定打印范围、纸张、方向、边距、重复表头、图片位置以及固定、页眉、页尾或明细区域。明细区域声明视图、共同组键、排序、每条记录高度、容量、空数据策略和超大组策略。校验会拒绝区域重叠、跨页键不兼容、错误续页引用、越界打印区域和未定义的字段引用。

## 核心调用顺序

服务端或集成层先通过 T01—T06 的适配器采集并整理出稳定数据集，再执行视图。每个结果视图以唯一 `recordId` 和字段 ID 保存记录。随后调用固定分页，再把页计划投影为彼此独立的工作表文档：

```ts
import { measureTemplateLayout, planFixedPages, projectPagePlan } from './core/index.ts';

const pagePlan = planFixedPages(templatePackage, 'page.main', viewResults);
const projected = projectPagePlan(templatePackage, pagePlan, viewResults, {
  parameters: { issueDate: '2026-10-02' },
});

for (const page of projected.pages) {
  const pageDefinition = templatePackage.pageDefinitions!.find(
    item => item.pageDefinitionId === page.pageDefinitionId,
  )!;
  const worksheet = templatePackage.worksheets.find(
    item => item.worksheetId === page.worksheetId,
  )!;
  const layout = measureTemplateLayout(worksheet.document, pageDefinition, page.worksheetId);
  if (layout.diagnostics.length) throw new Error(layout.diagnostics[0].message);
}
```

同一 `paginationGroupId` 下的多个视图区按相同业务键联动，即使集合数量不同也不会把两组一对多结果交叉乘增。组大小超过容量时默认报 `GROUP_TOO_LARGE`；只有模板明确允许按记录拆续页才会拆分。页码、总页数、组内与整单记录序号、页内/整单聚合、常量和参数均在页面投影阶段解析。投影不会修改输入模板和视图记录。

模板包 Excel 往返入口为 `importTemplatePackage(bytes, fileName, projectId)` 和 `exportTemplatePackage(templatePackage)`。结构化函数入口可从 `src/core/index.ts` 引用。T13 的投影结果包含页设置、图片资源引用和逐页文档；T14—T17 已将分页 XLSX 导出、全页 UI 预览、模板发布、生成快照和统一 HTTP 服务接入，调用和部署方式见 [reporting-api-v1.md](reporting-api-v1.md)。

## 当前限制与验收边界

- 当前有可运行的本地参考服务和模拟数据；接入生产 MES 仍需配置项目适配器、数据映射和身份授权。
- 页面布局测量会给出物理尺寸、换行和字体诊断。未注入完整字体测量器时使用字符宽度估算并发出警告；必须在目标 Excel/WPS、字体和打印机环境校准。
- 从工作簿导入的图片随原始 XLSX 保留。新增图片资源需要在模板包中提供资源数据并配置资源 ID；画布不提供图片裁剪和拖动控件。
- 分页 XLSX 已回读校验工作表、单元格、合并、行列尺寸、图片锚点和打印范围；尚未完成目标办公软件的实印兼容性验收。
- 当前验收使用合成数据，没有连接真实 MES 表或用户提供的原始质保书文件。生产字段映射、结果选择规则和实印效果仍需项目样本确认。

运行 `npm run verify` 可执行领域、模板包、分页、投影、Schema、Excel 回读、类型检查及生产构建验证。代表性新增用例位于 `tests/template-package.test.mjs` 和 `tests/template-pagination.test.mjs`。

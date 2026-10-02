# 单据模板设计器 · v0.2.0

Vue 3 + TypeScript + Pinia + Element Plus + Univer + ExcelJS。支持导入既有 Excel 排版、维护字段字典、拖拽绑定、配置多行明细、生成数据单据，以及保存后继续编辑。

## 启动

Windows 双击 `start-windows.cmd`，或运行：

```sh
npm ci
npm start
```

需要 Node.js 22.6+。已有依赖时无需重新安装。默认地址 http://127.0.0.1:5173。

```sh
npm run verify         # 领域 / 导入生成回读 / Schema / Excel / 类型检查 / 生产构建
npm run test:e2e       # Playwright 浏览器验收：导入、拖拽、分页、发布和输出
npm run seed:examples  # 安装达力普和第二 MES 模拟项目的四套示例模板
npm run benchmark:reporting # 输出本机合成数据生成基线
npm run build
npm run serve:dist     # 启动 dist 静态服务
```

`dist/` 为完整应用构建。`preview/index.html` 是历史 v0.1 的独立 HTML 演示，不包含新版 Excel 导入流程；请使用上述完整应用入口。积木入口已从新版界面移除，旧领域模块保留兼容性。

## 使用流程

1. **导入 / 打开模板**：选择 `.xlsx` 或已保存的模板 JSON。多工作表文件可选择本次编辑的表，其余表随文件保留。
2. **维护字段字典**：新增、编辑、删除、搜索、分组，设置字段路径、所属集合、必填、文本/数字/日期类型及 Excel 数字格式。已绑定字段改名会同步更新单元格，删除已绑定字段会被阻止。
3. **自动生成字段**：在“业务数据 / 生成”粘贴 JSON 对象，点击“自动生成字段字典”。扫描数组的所有记录，识别嵌套对象和数组，补齐不同记录中出现的字段；已有定义不会覆盖。空数组无法推断其字段，请提供一条样例或手动新增。
4. **设置明细区域**：选中一条记录对应的样板行，填写集合。每条记录可占多行。子集合关联父区域，并通过当前选区限定子明细的列范围。不同检验表可设置多个独立区域，也可复用同一集合。
5. **拖拽字段**：拖至真实目标格；合并单元格自动绑定到左上角。替换文字或公式时保留格式，可撤销。双击字段或属性面板“应用绑定”也可完成绑定。多行字段必须位于匹配集合的明细区域内。
6. **本地 JSON 预览**：以业务 JSON 填充单值和明细，自动复制行高、格式和合并，下移后续表格；嵌套明细可根据每条父记录生成不同数量的行。预览和 Excel 导出包含完整结果。
7. **项目服务生成**：启动参考服务，选择项目，导入业务字段目录并试算视图；将模板保存为草稿、发布后，按真实业务单号逐页预览、下载或重印固定快照。该流程在服务端使用同一份分页计划完成预览和 XLSX 导出。
8. **保存模板 Excel**：同一文件内包含占位符、字段字典和区域配置；重新导入即可继续编辑。也可保存 JSON，或使用 IndexedDB 自动草稿恢复。宿主协议 v1 保持兼容；支持协商协议 v2 的宿主可以接收完整模板包及生成文件。

“质保书示例”提供多层表头、炉号分组、多次化学分析、力学性能、无损检测、工艺检验和页脚示例，配有可直接生成的 JSON。示例为合成数据，不是图片中被遮挡内容的还原。

## 字段和多行数据

```json
{
  "certificate": { "number": "QC-001", "issueDate": "2026-09-30" },
  "heats": [
    { "number": "2512865", "tests": [{ "C": 0.26 }, { "C": 0.25 }] },
    { "number": "2512867", "tests": [{ "C": 0.24 }] }
  ]
}
```

单值 `certificate.number` 不设置集合。炉号 `heats.number` 所属集合为 `heats`；化学成分 `heats.tests.C` 所属集合为 `heats.tests`，子区域关联 `heats` 父区域。数组须为对象数组；数值数组应整理为 `[{"value": 1}]`。

## 支持范围

- `.xlsx`，单文件 20 MiB；编辑 / 生成最多 10000 行、200 列、500000 个单元格。
- 常规内容、日期、数字、公式、合并、行高列宽、字体、背景、边框及打印设置；图片在保存中保留，画布暂不显示图片。
- 每次编辑一个工作表；其他工作表由 ExcelJS 读写保留。已有自定义字典可继续用于新导入的外部排版。
- 数字字段要求 JSON 数值，日期要求有效 ISO 日期；必填缺失和数据类型错误会阻止生成。非必填缺失会填空并提示。
- 纵向多级重复区域，空数组可移除或保留空样板；同一行的并排检验列应合并为一个数据集合。独立区域不能纵向重叠。
- **旧版 `.xls`、加密文件、宏、图表、透视表和其他复杂 Excel 对象不在保证范围内。** 先转换为普通 `.xlsx`；重要原文件请保留。
- **含公式的模板支持保存，但分页生成会明确拒绝无法安全重定位的公式。** 可将计算值改为业务字段。Excel 回读校验覆盖工作表、单元格、合并、行列尺寸、图片锚点和打印范围；这不等于目标 Office 打印预览或实印验收。
- 内嵌元数据是再次打开时的编辑状态；请在设计器中继续修改已保存模板。若在 Excel 外部改动布局，应使用不含系统元数据表的副本作为新模板导入。
- 本地草稿仅属于当前浏览器和当前地址；请下载模板作正式保存。可选参考服务使用项目隔离的本地文件存储和样例适配器，不自动接入 MES 数据库。

## 主要模块

| 模块 | 职责 |
|---|---|
| `src/domain/model.ts` / `fields.ts` | 模型、可维护字典、JSON 字段推断、安全路径读取 |
| `src/domain/operations.ts` | 原子编辑、边界、合并、字段作用域及父子区域校验 |
| `src/domain/generate.ts` | 递归扩行、类型校验、合并和页脚迁移 |
| `src/domain/certificate.ts` | 质保书示例和合成业务数据 |
| `src/export/importExcel.ts` / `excel.ts` | Excel 导入、保真数据保留、导出与内嵌元数据 |
| `src/export/pagedExcel.ts` | 固定或流式分页投影到独立 XLSX 页工作表及回读校验 |
| `src/core/pagination/` / `src/core/render/page.ts` | 多区域分组分页和不可变逐页投影 |
| `server/` | 项目服务、原子本地仓储、模板匹配、生成快照和 HTTP API |
| `src/services/reporting.ts` / `src/components/preview/PagedPreview.vue` | 浏览器项目服务调用和逐页预览 |
| `src/stores/designer.ts` / `persistence.ts` | 撤销重做、文档替换、IndexedDB 草稿 |
| `src/components/TemplateDesigner.vue` | 导入、字典、区域、绑定和生成界面 |
| `src/adapters/univer.ts` | 受控网格、拖放命中、缩放与定位 |

验证记录见 `docs/verification-v0.2.md` 和 [T18—T20 验证记录](docs/verification-v1.md)；数据契约见 `docs/backend-contract.md`。WebView2 / CefSharp 的既有宿主协议见 `docs/host-integration.md`。

T21 流式分页的页面区域约定、组头组尾、末页合计及使用边界见 [流式分页配置](docs/flow-pagination.md)。
T21 的自动化结果与打印验收边界见 [流式分页验证记录](docs/verification-t21.md)。

T22 固定版式 PDF 的环境配置、项目开关及独立视觉验收见 [PDF 输出说明](docs/pdf-output.md) 和 [验证记录](docs/verification-t22.md)。

T23 的前后端同域部署、持久化、配置示例与重启冒烟流程见 [部署说明](deploy/README.md)。

T24 的 GitHub Actions 全量验证、浏览器验收、Compose 构建和重启后快照哈希检查见 [CI 与验收记录](docs/verification-t24.md)。

参考生成服务的启动、HTTP 路由、版本发布、自动匹配和快照重印说明见 [本地统一生成服务](docs/reporting-api-v1.md)。接口使用模拟数据；真实 MES 接入需要为各项目实现只读适配器并配置身份授权。

T01—T17 的通用数据核心、复杂固定分页、分页 XLSX、逐页预览、参考服务和宿主协议协商已实现。T18—T20 增加了达力普与第二 MES 模拟项目的四套模板、只读 HTTP 项目注册、浏览器接线修复和验收记录。项目接入、制版及差异说明见 [项目接入](docs/project-integration.md)、[模板制作](docs/template-design.md)、[达力普参考](examples/projects/dalipu/README.md)。真实 MES 适配、BFR 人工对照、目标办公软件实印校准和生产身份集成仍需按项目环境完成。

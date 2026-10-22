# T43 图片显示、编辑与保存验收记录

日期：2026-10-21。开始时核对 T42 验收记录和 T30—T42 累积未提交改动，保留原有改动。本轮没有提交或推送 Git。

## 任务与实现入口

| 任务 | 状态 | 实现与证据 |
| --- | --- | --- |
| T43.1 图片链路与基线 | 已实现 | `tests/fixtures/image-workbook.mjs` 使用合成印记构造双工作表、同表两图、合并单元格、自定义行高列宽、双单元格锚点及单单元格固定尺寸图片。`src/export/workbookImages.ts` 将原始图片关联到既有 `TemplatePackage.resources`，在容量限制内扩展图片所需行列。 |
| T43.2 画布显示 | 已实现 | `src/adapters/univer.ts` 复用已安装的 Univer 1.0.3 骨架、滚动状态和事件；就绪事件更新缓存，绘制回调不提前读取尚未注册的滚动服务。`imageOverlay.ts` 是挂在现有网格上的 DOM 图片层，没有建立第二套表格画布。支持工作表切换、40%—125% 画布缩放及滚动，释放动画帧、观察器和图片节点。 |
| T43.3 图片编辑 | 已实现 | 鼠标选择、移动、拖动右下角缩放；交互过程中只更新临时投影，释放时通过 `store.updateImage()` 进入原有 `commit()`、文档历史和撤销重做。无效坐标、非正尺寸及越界更新在修改状态前被拒绝。取消交互不提交。 |
| T43.4 保存重开 | 已实现 | XLSX 更新原图片锚点；JSON、IndexedDB、服务端草稿及发布版本使用原有存储链路。旧模板在打开时归一化一个副本；发布仓库中的旧记录不被重写。图片资源仍被工作表引用时禁止删除。 |
| T43.5 分页输出 | 已实现，有明确边界 | 原始固定图片和页面配置图片进入同一份逐页投影，供预览、XLSX 和固定分页 PDF 使用。保留单元格内的小数锚点。原始图片不再因另有页面配置图片而消失。本地 JSON 扩行通过既有行映射移动固定图片。动态重复区域、流式工作表及越过打印范围的原始图片明确报错，未新增逐记录图片复制语义。 |
| T43.6 全量检查与记录 | 自动验证已完成；外部验收待环境/材料 | `npm run verify`、完整 `npm run test:e2e`、`git diff --check` 均 exit 0；详见下方各项结果。Docker 和客户验收没有以自动测试替代。 |

## 原有能力与本轮补齐内容

| 能力 | 原有入口 | 本轮处理 |
| --- | --- | --- |
| Excel 读写和保留源工作簿 | `src/export/importExcel.ts`、`excel.ts` | 提取原始图片锚点和资源，保存时应用编辑后的锚点；自动打印范围包含图片。 |
| 图片资源和页面定位 | `TemplatePackage.resources`、`PageDefinition.imagePlacements`、`ImageResources.vue` | 继续使用既有资源仓库及页面图片配置，不新建图片存储。 |
| 设计网格和受控编辑 | `src/adapters/univer.ts` | 使用可见视口，避开位于屏幕外的缓存 canvas。只放行视口滚动命令，单元格数据写入仍受原控制。 |
| 文档事务及撤销重做 | `src/domain/operations.ts`、`src/stores/designer.ts` | 增加图片矩形验证和单次事务更新，复用按工作表保存的历史。 |
| 分页、预览和输出 | `src/core/render/page.ts`、`PagedPreview.vue`、`pagedExcel.ts`、`server/pdf` | 将原始图片并入已有投影；共享小数坐标换算，PDF 不重复读取已归一化的源图片。 |
| 发布仓库、快照和服务端接口 | `server/repositories/local.ts`、既有 HTTP/UI 流程 | 复用原实现；新增回归证明后续草稿修改不影响已发布图片。 |

没有新增依赖、绘图插件、模板仓库、分页器或 PDF 渲染器。没有修改部署证据 v2/v3/v4 的字段或兼容语义。

## 格式与旧格式兼容

模板包仍为 `contractVersion: 2`，文档仍为 `schemaVersion: 1`，Excel 元数据标记仍为 `BRICKBILL_TEMPLATE_V1` / `BRICKBILL_TEMPLATE_PACKAGE_V2`。本轮使用可选的图片布局扩展 **`imageLayoutVersion: 1`**：

```json
{
  "imageLayoutVersion": 1,
  "images": [{
    "imageId": "native.0",
    "resourceId": "excel.image.0",
    "sourceIndex": 0,
    "rect": { "r": 1.25, "c": 1.2, "rows": 2.25, "cols": 2.2 }
  }]
}
```

- `rect` 使用从零开始的单元格坐标，允许小数；它不是像素值。图片缩放通过现有行高、列宽换算，区别于要求整数的单元格选区。
- 图片字节复用包级 `resources`；源工作簿继续只保留在包级 `sourceWorkbook`。`sourceIndex` 指向源工作表中的原图片，保存时修改其锚点，保留图片内容和其他工作表对象。
- 没有该扩展的旧模板仍可读取。在设计器打开保留了源工作簿的旧模板时，提取图片并建立编辑状态；服务器中的已发布记录及历史生成快照不会因此重写。
- 已保存的新锚点在重开时具有权威性，不能重新从旧源工作簿覆盖。未知图片布局版本、无效坐标和缺失资源明确拒绝。
- 新版读取旧格式的兼容不代表旧版本软件能够执行图片编辑或理解新锚点；编辑后的模板应由当前版本继续维护。

## 行为回归

日志位于忽略提交的 `output/t43/`。

- `import-red.log`：旧导入仅保留原工作簿，预期两张可编辑图片实际为 undefined；之后导入回归通过。
- `canvas-red-browser.log`：实际 Chromium 导入后，预期两个画布图片节点，实际为零。首次受限环境浏览器启动未完成，不作为功能回归证据。
- `edit-red-browser.log`、`edit-visible.log`：实际坐标及命中检查暴露离屏缓存 canvas 和网格层级问题。最终测试明确核对图片在视口内且鼠标命中图片，再执行移动和缩放；不以离屏鼠标移动作为拖动功能的通过证据。
- `output-red.log`：原分页投影仅有一张页面配置图片，预期为两张原始图片加一张配置图片共三张；修复后数量和小数锚点回读通过。
- `far-image-red.log`：图片位于已填单元格以外时被错误判定超出工作表；扩展可编辑行列后通过。
- `print-range-red.log`：仅包含远处图片的模板自动打印范围错误为 `A1:A1`；修复后为包含图片的 `A1:N34`。
- `local-red.log`：本地扩行后的页脚图片应下移到第 17.25 行，实际仍在第 15.25 行；复用行映射修复后通过。
- `lifecycle-red.log`：首次全量浏览器回归中，两个既有项目配置场景均捕获到 `SheetScrollManagerService2` 尚未注册的页面错误。图片层绘制被动画帧或 ResizeObserver 提前触发；现改为由已就绪的 Scroll/SheetSkeletonChanged 事件更新缓存，绘制只读缓存。`lifecycle-initial-red.log` 进一步发现仅缓存变更事件会遗漏首次骨架，预期两图实际零图；补充 Univer 的 Steady 生命周期事件初始化缓存，`image-lifecycle-green.log` 的完整图片闭环通过。保留原有页面错误断言，并在新增图片浏览器回归中同样检查未捕获页面错误。
- 测试开发时的导出名称写错、对 Pinia Proxy 使用 structuredClone、直接操作仍在处理中的文件输入等问题均已修正，不计入产品行为缺陷证据。

新增图片测试已接入原有 `npm run test:excel`，PDF 回归加入原有 `tests/pdf.test.mjs`，浏览器回归加入原有 Playwright 套件。

PDF 回归读取实际 PDF 内容流，核对两页中的两次图片绘制、解码后的 RGB 内容和位置/尺寸变换矩阵。浏览器回归实际执行导入、移动、缩放、撤销/重做、Excel/JSON 保存、重开、切表、缩放、滚动、自动草稿恢复、服务端保存、预检、发布、逐页预览以及 XLSX/PDF 下载。设计器截图为 `output/t43/image-editor.png`，仅使用合成印记。

## 自动验证

已核实复用既有 Python、字体及依赖：ReportLab 4.4.9、Pillow 12.3.0、pypdf 6.10.0。

```powershell
$env:REPORTING_PDF_PYTHON = 'C:\Users\87790\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$env:REPORTING_PDF_FALLBACK_FONT = 'C:\Windows\Fonts\simhei.ttf'
$env:BRICKBILL_REQUIRE_PDF_TESTS = '1'
Remove-Item Env:T22_PDF_SAMPLE_OUTPUT -ErrorAction SilentlyContinue
npm run verify
npm run test:e2e
git diff --check
```

- **编码**：T43.1—T43.6 的可执行开发及记录已完成。定向图片回归 8 项；没有新增依赖。
- **`npm run verify`**：exit 0。主测试 113、Schema 3、Excel 11（含新增图片 8）、PDF 6、API 2、部署 29、宿主 2，合计 **166 项通过、0 失败、0 跳过**。Vue/TypeScript 检查及 Vite 生产构建通过（本次构建约 40 秒）。保留既有依赖的 `use client` 提示和约 9 MB 主 chunk 体积提示。
- **`npm run test:e2e`**：exit 0，**7 项通过、0 失败**（约 2.3 分钟）。包含两个既有项目的配置保存/重开、既有字段拖放及分页流程，以及新增原始图片导入、编辑、保存重开、发布和 XLSX/PDF 下载闭环；未屏蔽未捕获页面错误。
- **`git diff --check`**：exit 0。既有 `TemplateDesigner.vue` 的 CRLF → LF 提示不是空白错误。
- **PDF**：必测环境已启用，6 项零跳过。实际文件内容流、解码图像、两页绘制次数、位置及尺寸矩阵验证通过；没有依赖额外样张保存开关。

最终全量日志为 `output/t43/verify.log`、`e2e.log`、`diff-check.log`。首次失败和中间定向记录独立保存，不覆盖或冒充最终通过结果。

## 外部验收状态与支持边界

- **PDF**：当前支持固定分页，合成模板自动结构、内容和定位验证已通过；不等于客户批准样张或目标打印机的实印验收。
- **Docker**：本次复核 `Get-Command docker` 不存在，沿用 T41.4/T42 的待环境状态；浏览器/API 测试不算真实容器构建或命名卷恢复验收。
- **客户验收**：沿用 T41.5/T42 的待材料状态，仍需真实模板、MES 样本、批准基准及目标 Office/WPS 环境。合成印记不能作为真实印章或客户模板通过证据。
- **功能边界**：仅编辑导入原始图片的位置和大小。未新增图片裁剪、旋转、上传入口或逐记录图片复制；既有页面资源上传能力继续保留。原始固定图片在所属工作表页面按固定位置输出；页面配置图片原有首页/末页/每页语义保持不变。
- 全部修改保留在当前工作区，不自动提交或推送 Git。

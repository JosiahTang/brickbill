# 实际验证记录

> 本文是 v0.1.1 历史记录。新版完整应用已完成类型检查、构建及导入生成测试，见 [v0.2 验证记录](verification-v0.2.md)。

交付更新：2026-09-30。

## 已执行成功

- Node 22.16.0：46 项领域测试，46 通过。原 operations 相关 44 项，新增 demo 工厂 2 项。
- 全局 TypeScript 5.8.3：model.ts、operations.ts、blocks.ts、demo.ts 严格类型检查通过。注意：不是对未安装的工程 TypeScript 依赖版本或全部 Vue 文件的类型检查。
- Python jsonschema：Draft 2020-12 Schema 自身及 customer-block.example.json 校验通过。
- 系统 Chromium + Python Playwright：23 项附加离线预览检查通过。
- 预览检查包含真实 HTML5 拖放、整块移动、绑定文本、覆盖拒绝、越界回滚、明细字段作用域、合并/取消合并、背景和尺寸修改、非法尺寸拒绝、撤销/重做、新建撤销、模型 JSON 文件下载。
- 离线预览执行期间未发起外部 HTTP(S) 请求，未捕获浏览器脚本异常。
- 启动与静态服务器脚本通过 Node 语法检查。

对应记录：domain-test-output.txt、schema-validation-output.txt、offline-preview-test-results.json、offline-preview-test-output.txt、offline-preview.png。

## 明确未完成

- 依赖安装与真实 package-lock.json 生成。
- 完整 Vue / Pinia / Element Plus / Univer 的类型检查、打包和浏览器运行。
- ExcelJS 导出回读测试和 Ajv JavaScript 测试。
- WebView2 / CefSharp 实际 C# 宿主联调。
- Docker 镜像构建。
- 在线 Site 创建、上传、发布与 URL 验证。

## 实际阻塞证据

npm 依赖安装检查超时；curl 同时报告 registry.npmjs.org 域名解析失败。执行 `npm run build` 停止在 `vue-tsc: not found`，因为依赖尚未安装。见 network-check.txt 与 full-build-attempt.txt。

这不是已经完成安装后发现所有代码均可编译的证明，也不能据此判断业务集成一定有编译错误。代码包中不生成空的 dist 冒充构建产物，不手工伪造 lockfile。

## 浏览器测试方式

当前容器的 Chromium 策略阻止 file:// 导航。测试通过 Playwright `set_content` 加载同一个完整 preview/index.html，并实际操作 DOM、触发拖放与下载。该结果验证离线 HTML 的浏览器逻辑，不验证用户公司浏览器的文件策略，也不验证任何线上地址。

完整工程和额外离线预览的视图 / 状态容器不同。预览只能验证共用领域行为及其附加 HTML 界面，不能外推为 Univer、Pinia、ExcelJS 和 C# 均已验收。

## 正式集成验收建议

在可安装依赖的环境执行 npm run verify，随后测试 Univer 实际网格命中与变更投影、滚动后拖放、Excel 中文占位符、边框合并、数字日期格式、受控编辑、宿主来源校验/ACK/超时/幂等。生产发布以锁文件和 CI 为准。

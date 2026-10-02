# T24 持续集成与浏览器自动验收

`.github/workflows/ci.yml` 在 `main` 推送、面向 `main` 的 PR 和手动触发时运行两项作业。验证作业执行 `npm run verify`，显式安装 ReportLab、Pillow、pypdf 与 Noto CJK 字体，并安装 Playwright Chromium；PDF 用例因此不会因环境缺失而跳过。浏览器失败保留 Playwright trace、截图和视频。

Playwright 用合成达力普质保书样例执行以下路径：导入多工作表 Excel、将字段真实拖到画布、修改分页容量、保存并重新导入 XLSX 校验绑定和版式、刷新本地草稿、保存并发布服务端版本、预览主表和硬度附页、下载 XLSX 与 PDF 并比较生成快照。然后以大样本业务号生成多页单据，验证总页数和末页附页。测试数据只使用仓库中的合成来源。

Compose 作业构建前后端镜像，启用隔离的模拟项目与合成令牌，检查健康状态，发布样例模板并生成 XLSX；重启 `reporting-api` 后按同一生成标识重印，逐项比较页数与 SHA-256。作业清理临时卷前保存服务日志及重启前后的记录。

在本机 Windows 开发环境中，Playwright 端到端测试通过，覆盖模板导入、字段拖拽、分页配置、保存回读、发布、附页预览、分页 XLSX 和 PDF 下载。示例 PDF 仅在验收夹具中为长编号、合同号和说明行补足空间；实际客户模板仍须按客户版式和批准字体单独验收。完整 `npm run verify` 与 Compose 容器作业由 GitHub Actions 执行；当前开发主机没有 Docker，不能将本机 Compose 状态写作已通过。

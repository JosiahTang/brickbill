# 部署说明

## 当前实际状态

没有执行 Site 发布，没有生成公网预览 URL。当前环境没有 Site 发布工具，npm 域名也无法解析，不能在此生成经过验证的完整应用 dist。

本目录仅提供部署配置。不要将“提供配置”或“启动本地 HTTP 服务”称为“已发布网站”。

## 完整 Vue / Univer 应用

1. 在可联网安装 npm 依赖的环境解压工程。
2. 使用 Node 22.6+，执行 `npm install`，成功后保存真实生成的 `package-lock.json`。
3. 执行 `npm run verify`；它依次运行领域、Schema、ExcelJS 回读与完整构建。
4. 校验成功后，将 **新生成的 `dist/` 内容** 部署到静态站点平台或内部 Web 服务。
5. 通过浏览器进行真实拖放、Excel 下载、占位符/格式/合并回读验证；桌面宿主另行验收。

静态 Site 项目一般需要填写：

```text
项目根目录：解压后的 report-designer/
构建命令：npm run build
发布目录：dist
Node 环境：22.6+
```

这些值不是某个已创建站点的配置截图，也不代表已连通指定平台。平台若不会自动安装依赖，应先执行 `npm ci`（有锁文件）或首次 `npm install`。

Vite 使用相对资源路径 `base: './'`。当前仅单页、无前端路由；通常不需要额外 rewrite。完整应用应通过 localhost / HTTPS 打开。

## 本机构建产物验证

```sh
node scripts/serve-static.mjs --root dist --port 4173
```

服务器仅监听 127.0.0.1，是开发验收工具，不是公网生产服务。

## Docker 示例（本次未验证）

```sh
docker compose up --build
```

示例本机映射 8080 -> Nginx 80。Dockerfile 在构建阶段安装依赖并执行完整构建，运行阶段只复制 dist。镜像版本与依赖锁定应纳入项目自己的 CI；本次没有生成伪造的构建日志。

生产 HTTPS、鉴权、模板权限、审计和文件存储由你现有系统负责。示例不读取任何真实客户数据，也不含服务密钥。

## 附加离线交互预览

`preview/index.html` 是单文件、零远程资源的交互演示，可直接打开，也可作为静态资源上传到具备权限的站点。上传这个 HTML **只部署了 HTML 网格预览**，并没有部署完整 Vue/Univer/ExcelJS 应用。

其拖放/合并/字段/事务来自相同领域模块，但不含 ExcelJS 导出和 C# 通信。请不要把这两种验证结论混淆。

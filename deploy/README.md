# T23 部署和运行

`compose.yaml` 启动两个服务：Nginx 提供完整前端并将同域 `/api/` 转发到 Node 生成服务；Node 读取项目配置和持久化数据。后台镜像固定 Python 3.12、ReportLab 4.4.9 和 Pillow 12.3.0，PDF 字体由部署方挂载。项目模板、发布版本、生成快照、XLSX 和 PDF 存入 `reporting-data` 命名卷。

## 本机模拟部署

1. 将 `.env.demo.example` 复制为 `.env`，给 `REPORTING_TOKENS_JSON` 设置一个新生成的长随机令牌，例如 `{"只在本机使用的随机令牌":["dalipu-demo"]}`。`.env` 不进入 Git。
2. 安装可用的 Docker Engine 和 Compose，在项目根目录运行 `docker compose up --build -d`。首次构建需访问镜像与软件包源。
3. 打开 `http://127.0.0.1:8080`。设计器默认访问同域 `/api`；在“项目服务”输入刚设置的令牌。
4. 将该令牌放入本机 `BRICKBILL_SMOKE_TOKEN` 环境变量，设置 `BRICKBILL_SMOKE_CREATE_DEMO=1` 后运行 `npm run smoke:deployment`。输出的 `generationId` 用于重启后的重印验证。执行 `docker compose restart reporting-api`，设置 `BRICKBILL_SMOKE_GENERATION_ID` 为刚才的值，再运行一次冒烟检查；两次输出的 XLSX 哈希应一致。

冒烟脚本会在明确选择模拟模式时安装一份已有合成模板，按合成打印号生成单据，下载 XLSX 并验证重印。只配置 `BRICKBILL_SMOKE_GENERATION_ID` 时，它仅读取已有快照。若 PDF 项目开关已完成独立验收，可设置 `BRICKBILL_SMOKE_EXPECT_PDF=1` 再检查 PDF 文件签名。

## 正式项目配置

1. 将 `.env.example` 复制为 `.env`，设置项目令牌、`REPORTING_PROJECTS_FILE=/etc/brickbill/projects.json` 和 `REPORTING_DEMO_PROJECTS=disabled`。把项目注册 JSON 放在宿主的 `config/projects.json`；该目录只读挂载到后台。MES 源接口的令牌按注册项中的 `bearerTokenEnv` 放入 `.env`，启动前会校验存在。
2. 字体文件放在宿主 `fonts/`，后台只读挂载为 `/fonts`。经项目 PDF 样张验收后，设置 `REPORTING_PDF_FALLBACK_FONT=/fonts/<获准字体>.ttf` 和 `REPORTING_PDF_ENABLED_PROJECTS=<项目ID>`。没有完成 PDF 验收时，保持 PDF 项目开关为空。
3. 前端默认只映射到宿主 `127.0.0.1:8080`。跨机器访问应通过企业现有 HTTPS 入口转发到该端口；需要直接监听其他接口时再配置 `BRICKBILL_BIND`，并按企业网络规则限制访问。
4. 运行 `docker compose up --build -d`。`docker compose ps` 中两个服务均应为 healthy；`GET /api/health` 返回 `{"status":"ok"}`。后台若缺项目、令牌、字体或 PDF 依赖，会在启动时直接报出原因。

`REPORTING_MODE=production` 时默认不加载模拟项目，必须配置项目注册或显式选择模拟模式，并且必须配置项目令牌。独立启动 Node 后台时可通过 `REPORTING_HOST`、`REPORTING_PORT`、`REPORTING_DATA_DIR` 指定监听和存储；Compose 已将它们固定为容器网络和数据卷路径。非本机监听没有令牌时拒绝启动。项目注册和字段映射见 [项目接入](../docs/project-integration.md)，PDF 的许可、字体与视觉验收见 [PDF 输出说明](../docs/pdf-output.md)。

## 备份、恢复和升级

停掉前端和后台后，完整备份 `reporting-data` 命名卷及宿主的 `.env`、`config/` 和 `fonts/`；不要只复制某一份快照 JSON。在项目根目录建立 `backups/`，可运行：

```sh
docker compose stop report-designer reporting-api
docker compose run --rm --no-deps -u 0:0 -v ./backups:/backup --entrypoint sh reporting-api -c 'tar -C /data -czf /backup/brickbill-data.tgz .'
```

恢复时先准备**空数据卷**，还原 `.env`、`config/` 和 `fonts/`，再执行：

```sh
docker compose run --rm --no-deps -u 0:0 -v ./backups:/backup:ro --entrypoint sh reporting-api -c 'tar -C /data -xzf /backup/brickbill-data.tgz && chown -R 10001:10001 /data'
docker compose up -d
```

使用保留的 `generationId` 运行只读冒烟检查，确认恢复后的文件哈希。升级先备份，再更新镜像与配置，运行 `npm run verify`，最后 `docker compose up --build -d`。模板、视图与生成记录始终通过既有版本和快照格式读取。

当前开发主机没有安装 Docker，因此这里的容器启动与重启仍需在有 Docker 的环境完成；本机的配置、API、快照重开和构建测试记录见 [T23 验证记录](../docs/verification-t23.md)。

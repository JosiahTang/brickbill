# T23 部署和运行

`compose.yaml` 启动两个服务：Nginx 提供完整前端并将同域 `/api/` 转发到 Node 生成服务；Node 读取项目配置和持久化数据。后台镜像固定 Python 3.12、ReportLab 4.4.9 和 Pillow 12.3.0，PDF 字体由部署方挂载。项目模板、发布版本、生成快照、XLSX 和 PDF 存入 `reporting-data` 命名卷。

## 本机模拟部署

1. 将 `.env.demo.example` 复制为 `.env`，给 `REPORTING_TOKENS_JSON` 设置一个新生成的长随机令牌，例如 `{"只在本机使用的随机令牌":["dalipu-demo"]}`。`.env` 不进入 Git。
2. 安装可用的 Docker Engine 和 Compose，在项目根目录运行 `docker compose up --build -d`。首次构建需访问镜像与软件包源。
3. 打开 `http://127.0.0.1:8080`。设计器默认访问同域 `/api`；在“项目服务”输入刚设置的令牌。
4. 将该令牌放入本机 `BRICKBILL_SMOKE_TOKEN` 环境变量，设置 `BRICKBILL_SMOKE_CREATE_DEMO=1` 后运行 `npm run smoke:deployment`。输出的 `generationId` 用于重启后的重印验证。执行 `docker compose restart reporting-api`，设置 `BRICKBILL_SMOKE_GENERATION_ID` 为刚才的值，再运行一次冒烟检查；两次输出的 XLSX 哈希应一致。

单次只读冒烟可设置 `BRICKBILL_SMOKE_GENERATION_ID`，脚本读取已有快照、下载 XLSX 并核对哈希及重印结果。要在模拟项目中生成烟测记录，必须显式设置 `BRICKBILL_SMOKE_CREATE_DEMO=1`；这只支持 `dalipu-demo`。若 PDF 项目开关已完成独立验收，可设置 `BRICKBILL_SMOKE_EXPECT_PDF=1`：重印前后分别下载 PDF，验证签名、SHA-256 和字节数一致，失败不会输出通过记录。

## 正式项目配置

1. 将 `.env.example` 复制为 `.env`，设置项目令牌、`REPORTING_PROJECTS_FILE=/etc/brickbill/projects.json` 和 `REPORTING_DEMO_PROJECTS=disabled`。把项目注册 JSON 放在宿主的 `config/projects.json`；该目录只读挂载到后台。MES 源接口的令牌按注册项中的 `bearerTokenEnv` 放入 `.env`，启动前会校验存在。

生产签发需记录企业员工身份时，可在 REPORTING_TOKEN_ACTORS_JSON 中将已配置的 bearer token 映射到稳定员工号。只配置令牌但不配置此映射时，沿用旧版令牌短哈希操作者标识；配置了映射表后，未映射令牌仍可读取/预览，但不能签发。企业 SSO/网关继续由宿主通过现有 ReportingAuthorizer 接入，不能从请求体接收员工号。
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

### 自动备份和空卷恢复烟测

`npm run test:compose-smoke` 使用每次运行独有的 Compose 项目名、镜像标签和本机随机端口，只支持显式启用的 `dalipu-demo` 合成记录。它会创建全新的隔离数据卷，不能接收已有 `generationId`。已部署客户服务的已有记录，请对目标服务直接运行 `npm run smoke:deployment`，设置 `BRICKBILL_SMOKE_URL`、`BRICKBILL_SMOKE_PROJECT`、`BRICKBILL_SMOKE_GENERATION_ID` 和该项目令牌：

```sh
export BRICKBILL_SMOKE_TOKEN='本机或 CI 使用的项目令牌'
export BRICKBILL_SMOKE_CREATE_DEMO=1
npm run test:compose-smoke
```

脚本先验证合成 generation 和固定依赖，重启后台并复核同一 XLSX、模板/视图版本、函数定义及资源摘要，再停止服务、只读打包本次项目的数据卷。它检查新恢复卷为空、用 root 权限校验归档并还原，之后第二个隔离 Compose 项目须读取同一 generation、复核固定依赖并重印相同哈希。启用 `BRICKBILL_SMOKE_EXPECT_PDF=1` 时，各次烟测还下载实际 PDF，重印、重启及恢复后的 SHA-256 与字节数均须一致。完成日志收集和资源清理后，未要求 PDF 的结果写 `deploymentEvidenceVersion: 3`，已验证 PDF 的结果写版本 4。完整结果、备份归档和两套服务日志保存在当前脚本及 CI 共用的 `output/t38/<run-id>/`，不会随文档阶段编号自动改名。失败会保留主错误和清理错误；清理只针对本次生成且标签匹配的项目、卷和镜像。

检查真实项目的已有记录时，设置 `BRICKBILL_SMOKE_URL`、`BRICKBILL_SMOKE_PROJECT`、`BRICKBILL_SMOKE_GENERATION_ID` 和该项目令牌；此只读烟测会核对 XLSX、快照所固定的模板/视图版本和资源，不设置 `BRICKBILL_SMOKE_CREATE_DEMO`。版本 2/3 历史证据沿用各自原有检查，不补认 PDF 验证；v4 另外核对 PDF 摘要与长度，归档仍须与证据一并保存供验收 CLI 重算摘要。API 镜像包含 PDF 渲染器复用的 `scripts/compose-smoke-process.mjs`；本地隔离运行包启动回归不等同于 Docker 构建或容器验收。需要 Docker Engine 与 Compose 插件才能验收容器备份恢复；最新执行状态和材料边界见 [T40 验收记录](../docs/verification-t40.md)。

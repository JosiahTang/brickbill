# 项目接入操作

## 命令行接入检查

使用下列命令从合成项目定义生成注册文件、离线核对声明配置，并在接口就绪后按一个业务单号探测只读采集链路：

```powershell
npm run project:init -- --example dalipu --output config/projects.json
npm run project:validate -- --config config/projects.json
npm run project:validate -- --config config/projects.json --sample tests/fixtures/reporting/dalipu/source.json
npm run project:probe -- --config config/projects.json --project dalipu-demo --request-file samples/request.json --output output/project-probe.json
```

`project:init` 也支持 `--example general-mes`，并且默认拒绝覆盖已有文件。生成的项目名、源集合、源列和端点都是合成示例；正式接入时复制到项目配置目录，替换项目标识、字段映射和 MES 只读地址。离线 `project:validate` 不需要网络或令牌，可选 `--sample` 是 `ProjectSourceEnvelope` JSON，会用现有映射适配器和视图引擎做一次模拟采集。`project:probe` 使用已有只读 HTTP 适配器 POST `{projectId,documentType,businessKey}`，并调用全部已登记视图；报告记录源版本、数据集/视图行数和诊断，不写业务单号的值、源记录或令牌。令牌环境变量必须在执行探测时设置。

请求文件示例：

```json
{
  "documentType": "qualityCertificate",
  "businessKey": { "printNo": "真实打印号", "productPart": "T" }
}
```

运行 `project:probe` 会实际访问配置里的 `source.endpoint`，仅应指向已批准的只读采集接口。输出报告路径可供排查字段映射、采集数量和视图运行情况。

按业务确认的 MES/BFR 基准核对字段值、记录、顺序和汇总时，使用 `npm run project:compare`。离线与在线模式、套件格式和报告字段见 [`project-comparison.md`](project-comparison.md)。仓库合成基准仅作代码回归。

1. 确定业务入口和单据类型，如质保书打印号与产品类别。列出证书头、合同、物料、化学、力学、硬度、工艺检验各自的**记录粒度、复合主键、关联键和正式结果选择规则**。把合同检验要求与结果一起在单次采集快照中返回，避免生成中再次读取变化中的合同表。
2. 让 MES 提供只读 `POST` 数据接口，接收 `{projectId,documentType,businessKey}`，返回 `ProjectSourceEnvelope`。接口必须按请求业务键返回一份一致快照；不要让本工具直接调用 BFR 或写入旧分页表。源数据中的空值、重复键、类型错误会被现有适配器拒绝。
3. 生成项目注册 JSON 数组，单项包含 `project`（`ProjectDefinition`）、`adapter`（`ProjectAdapterDefinition`：数据集到源集合和字段的映射）、`views`（已定义视图）、`source`（`endpoint`、可选 `timeoutMs`、`maxResponseBytes`、`bearerTokenEnv`）。契约格式见 `docs/backend-contract.md` 和 `src/core/contracts/types.ts`。参考构造见 `src/core/adapters/example-projects.ts`；正式项目应保存自己的映射文件，不依赖示例项目 ID。
4. 在环境中设置 `REPORTING_PROJECTS_FILE` 为该 JSON 文件绝对路径，并按需设置 `bearerTokenEnv` 指定的密钥变量。启动 `npm run serve:api`。服务会用已有 `HttpProjectAdapter`、字段目录构建器和视图引擎验证注册，不执行注册文件中的脚本。重复项目 ID 或不完整配置会使启动失败。
5. 用业务单号调用视图预览接口，先对照物料、合同和检验记录数，再导入客户 Excel、绑定字段、配置页面并发布模板。发布时视图和函数版本被固定，生成时产生原始数据、视图、分页计划与文件哈希快照，可重印。

本地样例用 `npm run seed:examples` 安装四个合成模板；它们不会自动写入正式项目。前端用 `npm run dev`，参考服务用 `npm run serve:api`。参考服务默认数据目录为 `var/brickbill-reporting`；可在启动代码调用 `createLocalReportingRuntime(absolutePath)` 指定目录。停服务后备份整个数据目录（模板版本、视图版本、生成快照及文件），恢复时在停服务状态下整体替换并重启；不要只复制某一个 JSON。生产身份和接口网络访问仍须由宿主环境配置。

增加公共函数时，在 `src/core/functions/registry.ts` 的注册约定下定义输入数据集、输出字段、确定性版本与实现，并在运行时函数注册表登记；模板视图用 `applyFunction` 引用并发布。仅跨项目共通且无法由 `filter`、`sort`、`project`、`group`、`pivot`、`lookup` 表达的规则才新增函数。已发布版本不能改变语义，变更时升版本并添加有业务样本的测试。

T28 增加模板版本管理和质保书操作闭环：界面从项目模板目录打开草稿或指定发布版本，按项目业务键目录填写打印参数，完成预览后可确认签发；历史记录支持按业务键、模板、状态和日期分页检索，下载和重印沿用原快照。生产身份接入时，授权器需为每个请求返回项目范围和稳定操作者标识 `actorId`；不能把请求体里的姓名或操作者值作为审计身份。当前令牌参考授权器只返回令牌短哈希作为凭据标识，生产宿主应映射企业账号标识。

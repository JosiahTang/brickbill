# WebView2 / CefSharp 桥接

## 不要混淆两个宿主

WebView2 提供 window.chrome.webview 消息通道。CefSharp 不是 WebView2，一般通过 JavascriptObjectRepository 注册 C# 对象，再由 CefSharp.BindObjectAsync 获取代理。src/bridge/host.ts 将二者归一为 save(fileName, bytes, document)。无宿主时使用浏览器 Blob 下载。

示例既支持异步绑定的 templateHost，也支持宿主在页面执行前已经注入、具有 invoke 方法的同名对象。自定义代理须遵守相同协议。

## 请求 / 响应

请求使用 JSON 对象（WebView2）或相同 JSON 字符串（CefSharp invoke）。

```json
{
  "channel": "report-designer",
  "version": 1,
  "id": "请求 UUID",
  "action": "SAVE_TEMPLATE",
  "payload": {
    "fileName": "业务单据模板.xlsx",
    "byteLength": 12345,
    "base64": "实际 XLSX 字节的 Base64，不含 data: 前缀",
    "metadata": {},
    "document": {}
  }
}
```

只有文件和 JSON 真正保存成功后，宿主才返回 ok=true：

```json
{
  "channel": "report-designer",
  "version": 1,
  "id": "同一请求 UUID",
  "ok": true,
  "result": { "templateId": "服务端模板 ID", "revision": 7 }
}
```

失败返回同一 channel/version/id，ok=false，并提供用户可理解且不泄露内部路径的 error。WebView2 用 PostWebMessageAsJson 回传对象；CefSharp 的 invoke 返回响应 JSON 字符串。不能用裸字符串 “success” 替代协议。

JS 端按 id 关联并发响应，默认 30 秒超时，组件卸载时移除事件监听并拒绝 pending 请求。超时表示结果未知；不要自动重复保存。宿主应实现幂等键和保存状态查询。

## C# 接入位置示意（需要合入宿主工程）

CefSharp 对象只暴露业务方法，不暴露 Form/Window/任意文件系统访问对象。宿主应在可信设计器专用浏览器中注册，并禁止加载不受信任页面/iframe；普通代理函数的参数不能充当可信来源证明。

```csharp
// 在已经配置可信页面导航策略的宿主中注册。
// TemplateHost.Invoke(string json) 由宿主实现：验证、授权、持久化、返回协议响应。
browser.JavascriptObjectRepository.Register(
    "templateHost",
    new TemplateHost(),
    isAsync: true,
    options: CefSharp.BindingOptions.DefaultBinder);
```

默认方法名转换下，C# 的 Invoke 对应 JavaScript 的 invoke。JS 绑定完成后调用：

```javascript
await CefSharp.BindObjectAsync('templateHost');
const responseJson = await window.templateHost.invoke(requestJson);
```

WebView2 在 CoreWebView2.WebMessageReceived 读取 WebMessageAsJson；先检查事件 Source 的完整受信 Origin（scheme、host、port），再解析消息。消息不能携带任意执行脚本或本地路径。处理完成后通过 CoreWebView2.PostWebMessageAsJson 返回响应。

以上是集成接点，不包含已编译的 C# 保存服务；请用项目现有的认证、权限、存储和 UI 线程调度方式实现。

## 宿主必须再次校验

- 可信页面 Origin / 导航策略 / 禁止不可信子框架使用绑定对象。
- channel、version、action 白名单、UUID、字段权限、模板归属与 revision 并发控制。
- 文本消息长度、Base64 解码后长度、XLSX 格式有效性和必要的压缩展开配额。
- 文件名只能是显示名称，不允许 JS 指定磁盘路径；保存目录或文件选择框由宿主决定。
- 本例单文件 8 MiB、完整消息 16 MiB 是产品配额，不是框架自带上限。
- 持久化需保证 XLSX/JSON 对应同一修订版本，避免一半成功；返回成功前完成事务或原子提交。

大文件需另外实现 BEGIN/CHUNK/COMMIT/CANCEL，每段携带 transferId、seq、byteLength；宿主 ACK、限额、重试幂等、完整长度与 SHA-256 校验、临时文件清理都不可省略。当前 JS 代码没有伪装已经实现分块。

不要关闭 CEF/WebView2 的 Web 安全机制，也不要使用 eval、拼接 ExecuteScriptAsync 参数或任意反射来处理消息。后端依然要再次验证字段与模板权限，前端白名单不是授权边界。

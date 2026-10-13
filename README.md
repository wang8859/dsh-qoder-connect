# dsh-qoder-connect

在 DSH 中直接使用本机已登录的 **Qoder** 与 **Qoder CN** 桌面客户端账号：把本地登录态接入 DSH 模型路由（反向代理风格），自动查询模型与积分、每天自动领取签到积分，并提供状态卡片。

功能对标 `dsh-workbuddy-connect`，协议部分基于对 Qoder 客户端的本地调研与实测（见下文「工作原理」）。

## 功能特性

- **登录态读取**：读取本机 Qoder / Qoder CN 桌面客户端的登录凭据（`%APPDATA%\com.qoder.app.stable\auth.v1.dat` 与 `%APPDATA%\com.qodercn.app.stable\auth.v1.dat`，AES-256-GCM + Windows DPAPI），无需手工输入 Token。
- **模型与积分查询**：通过插件自带 HTTP 接口返回当前账号可用模型列表与剩余积分（`userQuota` / `addOnQuota`）。
- **每日自动签到**：插件内置定时器，每天自动调用签到接口领取每日积分；状态卡片可见领取结果。
- **模型调用**：注册到 DSH 的模型选择器，作为 OpenAI 兼容 provider 被 DSH 直接调用；请求中的 `reasoning_effort`（思考程度）字段**原样透传**给上游网关，不做任何改写。
- **状态卡片**：登录态、积分余额、最近签到/刷新结果、适配器运行状态、可用模型列表。
- **双区适配**：Qoder（国际）与 Qoder CN 使用不同的网关域名与凭据格式，分别适配；CN 推理面为 VPC 私网，推理自动委托国际通道，CN 账号仍负责额度与签到。

## 系统要求

- Windows（DPAPI 依赖当前 Windows 用户）
- 已安装并登录 **Qoder** 或 **Qoder CN** 桌面客户端（客户端启动时会刷新本地凭据文件）
- DSH（`@deepseek-ai/dsh` 0.2.0-rc.x）Web profile

## 安装

1. 将本仓库放到用户插件目录：

   ```powershell
   git clone <本仓库地址> "$env:USERPROFILE\.dsh\plugins\dsh-qoder-connect"
   ```

   若没有 git，也可直接把整个目录复制到 `C:\Users\<你的用户名>\.dsh\plugins\dsh-qoder-connect`。

2. 注册到 DSH profile（推荐用 dsh CLI，自动写入依赖与 bundles 名册）：

   ```powershell
   cd "$env:USERPROFILE\.dsh\profiles\web"
   dsh plugin add ..\..\plugins\dsh-qoder-connect
   ```

   > 说明：DSH 宿主加载的是 `profiles\web\node_modules\dsh-qoder-connect` 装机快照，不是 `plugins\` 源目录。`dsh plugin add` 会完成拷贝/链接并写入 `cordis.patch.yml` 的 bundle 名册；只复制源目录不注册会导致插件不生效。

3. 重启 DSH（或运行 `C:\Users\<你的用户名>\.dsh\dsh-workbuddy-restart.cmd` 一键重启宿主）。

4. 打开 DSH，在模型选择器中查找 `Qoder` / `Qoder CN` 分组下的模型。插件暴露的是**逐个经上游网关真实请求验证可用**的模型集合——国际版 `Auto`、`Ultimate`、`Performance`、`Qwen-Plus`、`Qwen-Flash`、`Kimi-K2.8-Preview`、`GLM-5.3`、`DeepSeek-V4-Pro`、`MiniMax-M3`，Qoder CN 为 `Auto`、`Qwen-Plus`、`Qwen-Flash`、`GLM-5.3`、`DeepSeek-V4-Pro`、`Kimi-K2.8-Preview`、`MiniMax-M2.7`。**选择器里能看到的，就是能用的。**

   > **模型可用性（0.1.5）**：不再照抄客户端 UI 那份「看起来更丰富」的列表。客户端模型列表接口（`/api/v2/model/list?Encode=1`）依赖客户端内置 WASM 运行时做请求签名，纯 HTTP 复刻不了；而客户端 UI 上的 key（`qmodel_38max`、`qfmodel`、`qmodel_latest`、`q37fmodel`、`fast`、`smodel`、`cmodel` 等）直接丢给推理网关会被判 `Unsupported model`。0.1.5 改为**以网关实测白名单为准**：`auto` / `qwen-plus` / `qwen-flash` / `gmodel` / `dmodel` / `kmodel` / `mmodel` / `performance` / `ultimate` 逐个真实请求验证 HTTP 200 且返回正文，全部收录；其余 key 一概不暴露。宁少不假。

## 使用

### 模型调用

在 DSH 模型选择器中选择 Qoder 系列模型即可对话。支持思考档位的模型会在选择器中暴露档位（档位集合由 `lib/index.js` 的 `reasoningFields()` 按模型的 `reasoning.efforts` 生成），选择后插件将 DSH 传来的 `reasoning_effort` 原样透传给上游。**`Qwen-Flash` 为免费模型（`price_factor: 0`），适合日常主力使用**；`GLM-5.3` / `DeepSeek-V4-Pro` / `Kimi-K2.8-Preview` 会先输出 `reasoning_content` 思考流再输出正文，思考内容会一并转发给 DSH。

### 状态卡片

DSH 设置页 → 插件 → `dsh-qoder-connect`，可看到：

- 两个账号（`qoder` 国际 / `qoder-cn`）各自的登录态（已登录 / 未登录、昵称、过期时间）
- 积分余额（总量/已用/剩余，单位 credits）
- 每日签到结果（今天已领取 / 领取成功 +N credits / 失败原因）
- 适配器运行状态与推理委托信息

### HTTP 接口

插件在 `http://127.0.0.1:8317/plugins/dsh-qoder-connect/` 提供以下接口（仅限本机回环访问）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | 双账号状态：凭据摘要、积分、最近签到/刷新、适配器状态 |
| POST | `/claim` | 手动触发签到，body 可带 `{"product":"cn"}` 或 `{"product":"intl"}` 指定账号，缺省双账号 |
| POST | `/quota` | 手动刷新积分，body 同上 |
| POST | `/login/start` | 发起设备码登录（`product: "intl" | "cn"`） |
| POST | `/login/poll` | 轮询设备码登录结果 |
| POST | `/logout` | 清除指定账号凭据 |

## 配置

无必需配置。插件首次运行会读取本地客户端登录态；凭据缓存在 `~/.dsh/.qoder-credentials.json`（仅当前用户可读）。

可选环境变量/行为：

- `DSH_HOME`：改变凭据缓存目录（默认 `~/.dsh`）。
- CN 账号默认启用推理委托（`inferenceProvider: 'qoder'`），即 CN 账号的对话请求由国际账号通道转发。若需关闭，可修改 `lib/index.js` 中 `emptyVariant('qoder-cn', 'cn')` 的 `inferenceProvider: null`，然后按「安装」步骤重新注册并重启。

## 工作原理

- **凭据来源**：Qoder 桌面客户端把登录态写入 `auth.v1.dat`（JSON，字段含 `token` / `refreshToken` / `expiresAt` 等），文件用 AES-256-GCM 加密、密钥经 Windows DPAPI 保护。插件通过 PowerShell `ProtectedData.Unprotect` 解密出 DPAPI 密钥后解析该文件，得到 OAuth `dt-` 令牌。
- **推理协议**：Qoder 网关接受 `Bearer <dt- OAuth token>` 直接调用 `POST https://api2-v2.qoder.sh/model/v1/chat/completions`（OpenAI 兼容流式）。插件在本地起一个 OpenAI 兼容 shim，把 DSH 的请求转发到该网关，并把响应的 SSE 流原样返回。
- **额度与签到**：调用 `GET https://openapi.qoder.sh/sash/api/v2/me/usage` 查询积分；`GET https://openapi.qoder.com.cn/sash/api/v1/me/campaigns`（CN 用 `.com.cn`）获取每日签到活动列表，再对 `CLAIMABLE` 的活动调用 claim 接口领取。
- **区域隔离**：Qoder CN 的 `dt-` 令牌只在 CN 域生效，且 CN 推理面位于 VPC 私网，公网不可达；因此 CN 账号的额度/签到走 CN 网关，模型推理委托给国际通道，卡片中分别展示。
- **模型目录（0.1.5 重构）**：早期版本把客户端模型缓存（`~/.qoder/.models/<uid>/catalog-v6`，AES 加密）解码后的 UI 列表直接当作 DSH 可选模型，结果是「列表很丰富、选一个报一个错」。0.1.5 改为以**推理网关实测白名单**为准：只有 `auto` / `qwen-plus` / `qwen-flash` / `gmodel` / `dmodel` / `kmodel` / `mmodel` / `performance` / `ultimate` 这 9 个 key 被逐个发真实请求验证（HTTP 200 + 正文非空）后收录，客户端 UI key 不再暴露。
- **模型 ID 映射**：`MODEL_ID_ALIAS` 保留 `qfmodel → qwen-flash`、`qmodel → qwen-plus`、`auto → auto` 三条兼容映射，用于历史配置里残留的旧 key；新目录已直接使用网关 ID，映射表只作兜底。
- **思考流**：上游对 `gmodel` / `dmodel` / `kmodel` 等思考型模型返回 `delta.reasoning_content` 字段承载思考过程。流式路径由 `onDataFrame` 原样转发；非流式路径在 `index.js` 聚合后回填为 `message.reasoning_content`，思考内容不丢失。
- **5xx 自动重试（0.1.4）**：免费模型后端偶发 `500 internal server error`（瞬时抖动）。`chat()` 对 5xx 响应自动重试最多 3 次（300ms / 600ms / 900ms 退避），大幅减少用户可见的偶发 500；连续失败才向上抛出原始错误。
- **流内瞬时错误重试（0.1.6）**：网关有时**先回 HTTP 200**，再把故障作为 SSE 错误帧塞进流里（`{"code":"provider_error","message":"All models failed"}`，所有后端短暂繁忙）。这类错误在首帧预筛阶段抛出，早于状态码分支，所以 0.1.4 的重试兜不住。0.1.6 增加 `isTransientUpstreamError()` 分诊：`provider_error` 走同样的 3 次退避重试；队列（`10605`）、计费（`110`）、鉴权（`105`）错误**明确排除**，仍原样上抛，避免把不可重试的错误拖成超时。
- **思考程度透传**：DSH 的 pi-ai 层把用户选择的思考程度映射为 `reasoning_effort` 参数发送给 shim；`buildChatBody` 检测到该字段后**原样写入**上游请求体，不做映射、改名或丢弃。已实测 `high` / `xhigh` 真实请求返回 200 且响应正常。
- **工具定义形状转换（0.1.7）**：DSH 宿主交给适配器的工具数组是扁平描述符 `{name, description, parameters}`，而 Qoder 网关只认 OpenAI 标准形状 `{type:'function', function:{name, description, parameters}}`，收到扁平形状会整单拒绝：

  ```
  'function' is a required property, expected an object - 'tools.64'
  ```

  该校验失败被网关包装成 SSE 错误帧（`provider_error` / `Error in upstream response`），最终以 HTTP 500 呈现在 DSH 里——这正是「所有模型都报 500」的真正原因（与具体模型、上下文长度、思考程度都无关，只取决于请求是否带工具，而 DSH 的每一轮请求都带 65 个工具）。0.1.7 在 `buildChatBody` 中新增 `normalizeTools()`：把每个扁平描述符包成标准 OpenAI 条目，已是标准形状的原样保留，缺 `parameters` 的补 `{type:'object',properties:{}}`。响应侧无需转换——上游回流的就是标准 `delta.tool_calls` 增量（`index` + `function.name` 首帧、`function.arguments` 分片累积、末帧 `finish_reason:"tool_calls"`），与 DSH 期望一致。修复后带全部 65 个工具的实测：9 个白名单模型中 8 个立即返回 200 + 正常正文。

## 常见问题

- **状态卡片显示 CN 401 / `token is not active`**：凭据文件缺少 `product` 字段导致 CN 令牌被路由到国际网关（旧版本 bug，0.1.1 已修复）。更新插件后，重启 DSH；若仍有问题，删除 `~/.dsh/.qoder-credentials.json` 并重启 DSH 让其重新从本地客户端采纳会话。
- **模型列表为空 / 适配器未运行**：确认本机已登录对应 Qoder 客户端；检查 `~/.dsh/.qoder-credentials.json` 是否存在；查看 DSH 日志 `%APPDATA%\DeepSeek Harness\logs\client.log` 中 `[qoder-connect]` 前缀的输出。
- **CN 账号无法推理**：这是 CN 区域限制（推理面在 VPC 私网）。插件默认将 CN 推理委托给国际账号，因此需要国际账号也已登录。
- **升级插件后不生效**：DSH 宿主只读取 profile 快照。升级后务必重新执行 `dsh plugin add`（或手动同步到 `profiles\web\node_modules\dsh-qoder-connect`）并重启 DSH。

## 参考与致谢

- 实现过程中的协议线索参考了 [aimod-cc/agent2api](https://github.com/aimod-cc/agent2api)（通用 OpenAI 网关与任务积分系统）与 [HUIdada1/AgentHub](https://github.com/HUIdada1/AgentHub)（其中 `adapter-qoder*` 为用量统计方向，非反代协议）。最终协议以本机客户端的实际网络行为实测为准。
- 插件形态与安装方式对标 `dsh-workbuddy-connect`。

## 免责声明

本插件仅用于在已登录的同一台 Windows 机器上复用 Qoder 账号能力，不修改客户端、不触碰账号数据以外的文件，凭据仅保存在本机。请遵守 Qoder 服务条款，理性使用。
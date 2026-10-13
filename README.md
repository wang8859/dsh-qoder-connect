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

4. 打开 DSH，在模型选择器中查找 `Qoder` / `Qoder CN` 分组下的模型。模型列表与桌面客户端完全一致（由客户端模型目录缓存解码而来），例如国际版包含 `Auto`、`Ultimate`、`Fast`、`Performance`、`Efficient`、`Qwen3.8-Flash`、`Qwen3.8-Max`、`Qwen3.7-Plus`、`Qwen3.7-Max`、`DeepSeek-V4-Pro`、`DeepSeek-Flash`、`GLM-5.3`、`GLM-5.3-Flash`、`Kimi-K3`、`Kimi-K2.8-Preview`、`MiniMax-M3`、`Sonus`、`Cantus` 等；Qoder CN 另含 `Qwen3.7-Flash`、`GLM-5.2` 等区域专属模型。

   > **模型可用性（0.1.3）**：`Qwen3.8-Flash`（免费）与 `Qwen3.7-Plus` 已实测可通过 `api2-v2` 网关直接调用。客户端模型目录中的 UI key（如 `qfmodel`）与网关真实模型 ID 不同，插件会自动把 `qfmodel` 映射为 `qwen-flash`、`qmodel` 映射为 `qwen-plus` 后再请求上游；其余模型（`Qwen3.8-Max`、`GLM-5.3`、`Kimi-K3`、`DeepSeek-V4-Pro` 等）目前客户端走独立后端，`api2-v2` 网关暂不认对应 ID，选择后会返回 `invalid_model_error`。推荐日常使用 `Auto`、`Qwen3.8-Flash` 或 `Qwen3.7-Plus`。

## 使用

### 模型调用

在 DSH 模型选择器中选择 Qoder 系列模型即可对话。支持思考程度档位的模型会在选择器中暴露 `off / low / medium / high / xhigh` 等档位（档位集合取自客户端模型目录的 `thinking_config`，不同模型不同），选择后插件将 DSH 传来的 `reasoning_effort` 原样透传给上游。**免费模型 `Qwen3.8-Flash` 与 `Qwen3.7-Plus` 为开箱即用推荐模型**；选择其余高级模型时若上游返回 `invalid_model_error`，说明该模型尚未开放给 `api2-v2` 网关，请改用上述推荐模型。

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
- **模型目录**：插件内置的 `CATALOG` 由 Qoder 客户端本地模型缓存（`~/.qoder/.models/<uid>/catalog-v6`，AES 加密）经客户端 SDK 的解密函数解码而来，因此模型 key、显示名、思考档位、上下文长度均与桌面客户端一致（0.1.2 起，替换了早期手写的旧快照）。
- **模型 ID 映射**：客户端目录的 `key` 是 UI 标识（如 `qfmodel` = Qwen3.8-Flash），而 `api2-v2` 网关要求真实推理模型 ID（如 `qwen-flash`）。0.1.3 起插件内置 `MODEL_ID_ALIAS`（`qfmodel → qwen-flash`、`qmodel → qwen-plus`），在 `buildChatBody` 中完成映射后再发送；未映射的 key 原样透传，由网关决定是否支持。
- **5xx 自动重试（0.1.4）**：免费模型后端偶发 `500 internal server error`（瞬时抖动）。`chat()` 对 5xx 响应自动重试最多 3 次（300ms / 600ms / 900ms 退避），大幅减少用户可见的偶发 500；连续失败才向上抛出原始错误。
- **思考程度透传**：DSH 的 pi-ai 层把用户选择的思考程度映射为 `reasoning_effort` 参数发送给 shim；`buildChatBody` 检测到该字段后**原样写入**上游请求体，不做映射、改名或丢弃。已实测 `high` / `xhigh` 真实请求返回 200 且响应正常。

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
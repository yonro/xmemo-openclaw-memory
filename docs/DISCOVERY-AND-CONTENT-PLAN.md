# XMemo for OpenClaw：产品介绍与 GEO / SEO 执行方案

更新：2026-09-28 · 当前事实基线：1.0.18 · 状态：仓库文案与双语 schema parity 已更新；网站、npm、ClawHub 未在本次发布。

## 1. 目标与统一口径

让用户和检索系统准确理解三个问题：XMemo for OpenClaw 是什么、现在能做什么、如何开始。当前主定位是 **OpenClaw 原生云记忆插件**；完整 Local / Hybrid 是有验收门的产品路线，不是现有版本卖点。

统一事实来源为 [PRODUCT-FACTS.md](PRODUCT-FACTS.md)。包名 `@xmemo/openclaw-memory`、插件 ID `xmemo-memory`、产品名 XMemo for OpenClaw 应在所有入口保持一致。Skill 是使用指导；本 npm 包是宿主插件；`https://xmemo.dev/mcp` 是独立的远程 MCP 入口。不要为搜索关键词把三者混称。

Google 的官方说明表明，AI 搜索沿用基础 SEO 要求，没有额外必需的“AI文件”或特殊标记；新发布的生成式 AI 搜索指南补充了内容建议，但不构成保证排名的承诺。这里的 GEO 指清晰、可引用、可验证的产品内容，不承诺排名或 AI 推荐。[Google AI 搜索说明](https://developers.google.com/search/docs/appearance/ai-features) · [Google 生成式 AI 搜索指南](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide)

## 2. 可直接复用的当前版介绍

以下文案只描述1.0.18。发布时同步核对实际最新版本；不能只替换版本号而不重新验证能力。

### 2.1 一句话与包描述

**英文 tagline：**<br>
Persistent cloud memory for OpenClaw, shared across your approved AI clients.

**中文 tagline：**<br>
为 OpenClaw 提供长期云记忆，让已授权的 AI 客户端接续上下文。

**英文 package / manifest 描述（已写入工作区）：**<br>
OpenClaw memory plugin for XMemo cloud: persistent memory, semantic recall, cross-agent sharing, TODOs, and restart snapshots.

**中文短描述：**<br>
XMemo for OpenClaw 是原生云记忆插件，提供长期记忆、语义召回、跨客户端共享、TODO 和重启快照。

### 2.2 英文目录长介绍

XMemo for OpenClaw connects OpenClaw to persistent XMemo cloud memory. Search and read relevant memories, save decisions, manage TODOs, record events, and save or restore restart snapshots through native OpenClaw tools. Approved AI clients can reuse memories within the same account and authorized scope.

The plugin registers as an OpenClaw memory provider and exposes 16 tools. It supports browser authorization and XMemo credential setup; automatic capture is optional and disabled by default. Cloud ledger and audit tools require the corresponding permissions.

Version 1.0.18 requires a configured XMemo service. Its local cache and selected write queue provide limited fallback, not a standalone offline memory database. Complete local memory and optional local/cloud Hybrid are planned. See the versioned product facts and setup guide for current requirements and limits.

### 2.3 中文目录长介绍

XMemo for OpenClaw 将 OpenClaw 接入长期 XMemo 云记忆。你可以通过原生工具搜索与读取相关记忆、保存决策、管理 TODO、记录事件，以及保存和恢复重启快照。同一账户下已授权的 AI 客户端，可以在允许范围内接续这些记忆。

插件接入 OpenClaw 的原生 memory slot，提供16个工具，支持浏览器授权与 XMemo 凭证配置。自动捕获是默认关闭的可选功能；账本与审计工具需要对应权限。

1.0.18 需要配置 XMemo 服务。本地缓存与部分写入队列提供有限容错，尚不构成完整离线记忆库。完整本地记忆与可选 Local/Cloud Hybrid 正在规划；实际安装要求与能力边界请以版本化产品事实页为准。

### 2.4 网站标题与摘要草稿

| 字段 | 英文 | 中文 |
|---|---|---|
| Title | XMemo for OpenClaw — Cloud Memory Plugin | XMemo for OpenClaw：长期云记忆插件 |
| H1 | Persistent cloud memory for OpenClaw | 为 OpenClaw 提供可接续的长期云记忆 |
| Meta description | Add XMemo cloud memory to OpenClaw: semantic recall, shared context, TODOs, and restart snapshots. Explore setup, permissions, and current limits. | 为 OpenClaw 接入 XMemo 长期云记忆，支持语义召回、跨客户端共享、TODO 与重启快照。了解安装、授权及当前本地能力边界。 |
| Primary CTA | Install the plugin | 安装插件 |
| Secondary CTA | Read setup and product facts | 查看配置与产品事实 |
| Roadmap label | Planned: standalone local memory and optional Hybrid | 规划中：独立本地记忆与可选 Hybrid |

这些是待网站落地的文案，并非已修改线上 `<title>` / meta。摘要长度以真实搜索展示和可读性调整，不使用固定字符数作为排名保证。社交分享标题/摘要采用同样事实，图片优先复用现有品牌图，alt 写内容而非堆关键词。

### 2.5 当前版页面结构和演示内容

1. 首屏：一句定位、云服务依赖、安装按钮；路线图放独立区域。
2. 真实工作流：保存项目决策 → 搜索 → 按ID读取 → 更新 → 用另一个已授权客户端接续。演示使用合成资料，展示权限范围。
3. 功能表：16工具按记忆、工作流、治理分组；写清哪些需额外权限。
4. 安装与授权：以当前 README 中已核对的安装、浏览器登录、状态检查步骤为准；不能让文案示例泄露真实 key。
5. 数据流与边界：发送到云的内容、本地缓存/队列、自动捕获默认关闭、不可离线完整运行。
6. FAQ：直接回答模式、Skill区别、权限、断网、迁移与支持版本。
7. 更新与来源：文档版本、最后核对日期、源代码、版本记录和问题反馈入口。

演示脚本：创建合成决策“示例项目使用周一发布窗口”；读取确切记录；改为周二；验证搜索不会把旧值当作最新；删除后验证不可正常召回。跨客户端部分单独录制真实结果，未通过前不能用剪辑或伪造截图充当验收。

## 3. FAQ 与可引用回答规范

已在中英文 README 和事实页提供常见问题。网站与目录直接复用以下事实，不自行发挥：

| 用户问题 | 当前版直接回答 | 后续允许改变的条件 |
|---|---|---|
| 不配置云能用吗？ | 当前不能完整运行；需要已授权 XMemo 服务 | 完整 Local 门通过并发布 |
| 能离线搜索全部记忆吗？ | 不能；缓存只覆盖部分先前查询 | 全库本地索引和离线包通过 |
| 和本地LanceDB有什么区别？ | 当前主要区别是云端权威与跨客户端访问；不声称检索更优 | 固定版本对照评测公开 |
| Hybrid是什么意思？ | 规划为本地独立读写加明确范围的云同步，不等同于当前outbox | 协议、冲突、删除、撤权验收 |
| 会自动记下全部对话吗？ | 不会；自动捕获默认关闭，启用后选择性匹配 | 捕获契约变更并明确告知 |
| 数据是否完全不落盘？ | 不是；本地缓存和队列可含内容 | 不以云模式推断零落盘 |
| 支持哪些AI客户端？ | 共享取决于客户端已接入同一XMemo服务及其授权范围 | 每个新增客户端实际验证 |
| 插件、Skill、MCP如何选择？ | 插件提供OpenClaw原生运行；Skill提供指导；MCP是另一连接入口 | 架构改变时同步事实登记 |

每个可引用答案应独立包含产品名、版本/模式、直接结论和限制；避免答案离开上下文后把“计划支持”变成“已经支持”。比较页面注明来源、日期、参考提交、配置和测试未覆盖项。

## 4. 搜索意图与内容地图

以下是内容组织假设，**未获得搜索量数据**，不能称为已验证的热门关键词。先覆盖用户问题，后依据真实查询改进。

| 搜索意图 | 建议内容 | 当前可写/发布边界 |
|---|---|---|
| XMemo OpenClaw / OpenClaw记忆插件 | 专属产品页、README、安装入口 | 当前云能力与精确实体信息 |
| OpenClaw persistent memory / 长期记忆 | 断会话后找回项目决策的真实教程 | 当前已实现工作流与云依赖 |
| OpenClaw ChatGPT memory / 跨agent记忆 | 允许范围内的跨客户端交接教程 | 每个展示客户端需实测 |
| OpenClaw memory plugin setup / 安装 | 安装、浏览器登录、环境凭证、status | 与当前CLI一致 |
| OpenClaw memory offline / 本地记忆 | 当前限制FAQ、明确标记的Local路线图 | 不把未实现功能做成下载承诺 |
| OpenClaw hybrid memory | 设计说明、Local/Hybrid/Cloud区别 | 发布前醒目标注规划 |
| XMemo vs LanceDB / Mem0 / Tencent | 各自适用场景、来源与固定版本对照 | 不以下载量证明性能，不发表未做基准的排名 |
| OpenClaw memory privacy / 故障 | 缓存、权限、数据去向、诊断与恢复指南 | 故障处理方法必须与实现一致 |

不为每个同义词生成重复页面，不把未验证竞品描述批量铺到站点。每页有独立用户问题、证据与内部链接，先完成产品页、安装页、数据边界页，再开展可重复教程和对比内容。

## 5. 网站 SEO 技术交付

当前仓库是插件仓库，不承载 xmemo.dev 的页面路由。以下交付应由网站仓库执行；本次没有部署，也没有验证 robots、sitemap、canonical 或Search Console状态。无法读取的资源不能直接判断为缺失。

### 5.1 专属页面及多语言

- 建议新增专属 `/integrations/openclaw` 页面及对应中文路由，**路径待网站路由规范确认，当前不作为已上线链接使用**。现有 `https://xmemo.dev/product/mcp` 保留给通用MCP产品；在专属页面真正上线前不修改 package.productPage 指向不存在的地址。
- 独立语言URL互相链接；各语言页面设置适当canonical，不能把完整中文译文全部canonical到英文；`hreflang` 列出自身与对应版本且双向一致，使用绝对地址。语言切换不强制登录。[Google多语言页面说明](https://developers.google.com/search/docs/specialty/international/localized-versions)
- 主要介绍、安装、FAQ与边界应出现在可抓取的HTML文本中。检查无意的noindex、登录墙、CDN拦截、404与重定向循环；产品页从首页/集成目录/文档目录有内部入口。
- sitemap只收录实际公开的canonical页面；修改产品链接时保持README、发现配置和站点一致。页面的更新日期来自真实内容变化。

当前公开 [MCP产品页](https://xmemo.dev/product/mcp) 还包含面向市场审核者的检查步骤。建议将审核流程移到贡献者/审核文档，产品主页面优先回答用户需求、安装、权限与限制。这是阅读当前页面后的编辑建议，不是已执行的网站修改。

### 5.2 结构化数据

网站可按可见产品内容建立 `SoftwareApplication` / 合适的软件实体信息：name、description、url、version、代码仓库、实际支持环境等；与页面正文逐项一致。当前缺少可核实的评价与完整报价信息，不生成星级、虚构review、用户数或“完全免费”的offers。

Google的软件应用富结果要求应用名称、报价价格，以及评价或汇总评分；收费报价还应提供货币。不要为获得富结果而编造价格或评价。普通软件实体标记不等于满足富结果资格，发布后应使用 Google 检查工具验证实际结构化数据。[Google软件应用结构化数据](https://developers.google.com/search/docs/appearance/structured-data/software-app)

FAQ首先是可读内容，不以添加FAQ schema保证展示。安装命令不能被JSON-LD替代；机器可读信息不得包含账户身份、凭证或私有记忆。

### 5.3 GEO可发现性

- 保留公开 `agent-discovery.json` 与OpenClaw配置发现的真实产品关系，检查端点/包名/插件ID与当前发行一致。这些服务实际输出由网站/服务端仓库负责，插件工作区修改不会自动改变它们。
- `llms.txt` 若要试验，仅作为公开文档导航；标记实验，使用同一事实来源，不能承诺提升引用率。优先可抓取文本、准确答案、版本证据和稳定URL，不把新增文件数量当完成度。
- 搜索抓取、模型训练与产品授权是不同策略。只公开产品文档；私有记忆API、登录态与凭证不因“GEO”开放。爬虫策略更改需由网站负责人按实际目标检查，不笼统放开所有路径。
- 公共基准包含数据集许可、固定配置、复现步骤、摘要结果与限制。正文先给可验证结论，再链接方法，避免只有宣传图缺少可提取文字。

## 6. 渠道交付清单

| 渠道/文件 | 本次工作区状态 | 发布前动作与负责人 |
|---|---|---|
| README.md / README_CN.md | 已完善介绍、能力边界、16工具、schema参数目录、host search能力、FAQ与配置说明 | 插件维护者随正常版本评审 |
| package.json | 已统一描述、相关关键词，纳入产品事实页 | 发布负责人打包检查后发布；无版本号擅自升级 |
| openclaw.plugin.json / index.ts | 已统一描述；纠正捕获说明与recall提示默认值 | 插件维护者验证宿主元数据；运行逻辑未改 |
| PRODUCT-FACTS.md | 已新增，npm分发包含 | 每版能力/默认值变更时同步 |
| GitHub仓库About/topics | 提供下方可复用文案，未远程更新 | 仓库管理员落实 |
| npm / ClawHub列表 | 本地内容待正常发布；未远程改写 | 发布负责人核对README、描述、最低宿主、安装包 |
| xmemo.dev专属产品页 | 文案与技术要求已交付；未创建或部署 | 网站负责人落实路由、语言、索引与实际页面检查 |
| discovery/config | 已有链接保留，未改服务端输出 | 服务端负责人核对公开能力与发行一致 |
| 基准与成功案例 | 只提供计划，没有领先成绩 | 质量负责人完成真实验证再交内容负责人 |

**GitHub About建议：** OpenClaw memory plugin for XMemo cloud: persistent memory, semantic recall, and shared context across approved AI clients.

**GitHub topics建议：** `xmemo`, `openclaw`, `openclaw-plugin`, `agent-memory`, `cloud-memory`, `semantic-search`, `cross-agent-memory`。Local/Hybrid尚未实现时不将其作为无说明的当前产品标签。

**ClawHub简介建议：** 使用§2.1短描述、§2.2/2.3长介绍，紧邻安装入口写明当前云授权要求；链接事实页与对应发布说明。工具数从manifest验证，不把Skill下载量和插件下载量合并。

## 7. 执行切片与验收

| ID | 动作 | 完成证据 |
|---|---|---|
| D0 本地一致性 | README、facts、package、manifest的名称/16工具/参数schema/当前模式一致；检索阈值与host search status字段有来源证据 | 重复运行 schema parity 测试、跨文档链接与内容检查、pack清单；本次结果见任务交付 |
| D1 正常发行 | 将文档与元数据随已验证版本发布至npm/ClawHub | 实际包版本与文件清单、目录页面展示、全新安装；本次未执行 |
| D2 网站交付 | 确认路由、落地双语产品/安装/数据边界页及内部链接 | 渲染HTML、HTTP状态、移动端、canonical/hreflang、sitemap、爬虫检查 |
| D3 发现信息 | 统一站点、discovery、README与目录链接 | 匿名读取无秘密、真实链接与能力一致 |
| D4 成效基线 | 建立发布前查询/页面/引用测量，发布后复查 | 时间窗口一致的记录；不把自然波动归因单一文案 |
| D5 Local/Hybrid文案升级 | 仅随相应工程验收更新能力登记、教程与介绍 | 独立模式门通过、版本/平台/性能限制公开 |

每次发布维护一个声明变更表：claim ID、此前文案、新文案、能力版本、证据、负责人、受影响渠道。网站尚未同步时保留已知差异，不把“仓库改好”记为“所有渠道完成”。

## 8. 效果衡量

建立发布前28天基线，发布后用相同长度窗口观察，并标注版本发布、推广与季节变化。新页面从首个可索引时间起计；低样本时延长观察，不强行推断增长。

- SEO：页面能否被索引、品牌/非品牌相关查询的展示与点击、安装文档到达、用户实际完成配置的比例。安装完成指标使用同意提供的匿名汇总或研究样本，不新增默认插件遥测。
- GEO：固定中英文问题集，每次记录日期、产品/模型、检索开关、地区/语言、回答与引用URL；同一问题重复抽样，统计事实准确率、正确引用率、是否把规划误报为当前。不以一次答案代表所有AI系统。
- 文档质量：失效链接数、错误命令反馈、当前/规划误解率、首次配置失败原因；产品团队据此修订内容。
- 下载：仅作分发趋势指标，保留npm/ClawHub各自口径与时间窗口；不等同独立安装、活跃用户、付费用户或质量。

Google AI搜索的流量包含在Search Console的Web总体数据里，不应把该总量直接标为独立AI引用增长。[Google衡量说明](https://developers.google.com/search/docs/appearance/ai-features)

目标先设为可控制的交付：关键事实错误为0、公开安装步骤可执行、关键链接有效、规划能力标签完整。流量与AI引用是观察结果，不写无法保证的“30天排名第一”。本文件未创建定时监控或发布自动化。

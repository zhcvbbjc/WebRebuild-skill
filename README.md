# WebRebuild Skill

一个用于大型网站前端逆向、全站证据采集、接口分析和本地重建的 Codex Skill。

`web-rebuild` 不把截图猜测作为起点。它会优先提取浏览器实际交付的 HTML、DOM、CSS、字体、图片、JavaScript、Source Map 和网络请求，再根据证据建立站点图、接口契约、登录流程和实现计划。

## 核心能力

- 自动识别 MACCMS、Next.js、Nuxt、React/Vue SPA、Astro、Remix、Angular、SvelteKit、WordPress、Shopify 等技术栈。
- 采集首屏与注水后的 DOM、计算样式、CSS 变量、响应式布局和截图。
- 沿 CSS `url()`、`@import` 继续提取字体、背景图等传递依赖。
- 发现并保存公开可访问的 Source Map 和 `sourcesContent`。
- 对全站入口进行可恢复、有上限、去重后的路由爬取。
- 生成站点图、路由覆盖、分页和页面族信息。
- 采集脱敏后的 API URL、状态码、字段结构和错误形态。
- 识别账号、密码、验证码、扫码、CAPTCHA 和第三方登录门槛。
- 对导航、标签页、筛选、分页、弹窗、播放器和账号操作生成交互清单。
- 对比原站与本地站，输出像素差异、链接结构、标题和关键盒模型报告。
- 根据采集结果生成 `rebuild-plan.json` 和 `rebuild-brief.md`。

## 工作原则

1. 优先复用合法可用的原始资源。
2. 其次恢复 Source Map 中的可读源码。
3. 再根据运行时 DOM、资源和网络行为进行逆向。
4. 只生成缺失部分，并明确标记 `observed`、`inferred` 或 `reconstructed`。

`web-rebuild` 的目标是 1:1 复现可观察体验，包括布局、内容、路由、响应式、交互状态和已知接口行为。私有的服务端实现、DRM、支付、风控、短信和第三方认证无法仅凭前端凭空还原，必须使用本地实现、可控适配器或明确标注的模拟数据。

## 环境要求

- Node.js 20 或更高版本。
- Google Chrome 或 Microsoft Edge。
- 网络访问权限。

脚本使用 `playwright-core` 驱动本机浏览器，不要求额外下载 Playwright 浏览器。

## 安装

将仓库直接克隆为 Codex Skill 目录：

```powershell
git clone https://github.com/zhcvbbjc/WebRebuild-skill.git "$env:USERPROFILE\.codex\skills\web-rebuild"
cd "$env:USERPROFILE\.codex\skills\web-rebuild"
npm install
```

也可以在任意开发目录中克隆，并直接运行脚本：

```powershell
git clone https://github.com/zhcvbbjc/WebRebuild-skill.git
cd WebRebuild-skill
npm install
```

## 快速开始

### 完整逆向流水线

```powershell
node scripts/reverse_site.mjs `
  --url "https://example.com/" `
  --out ".web-rebuild-output/example" `
  --max-pages 200 `
  --max-depth 4 `
  --channel chrome
```

该命令依次执行：

1. 首页资源与技术栈探测。
2. CSS 依赖闭包和跨域资源导出。
3. 可恢复的多页面爬取。
4. 登录门槛、接口结构和交互控件分析。
5. 重建计划生成。

`--max-pages` 和 `--max-depth` 是明确的安全边界。达到边界后，任务会标记为未完成，并将剩余 URL 保存在队列中。

### 继续未完成的爬取

```powershell
node scripts/reverse_site.mjs `
  --url "https://example.com/" `
  --out ".web-rebuild-output/example" `
  --max-pages 1000 `
  --max-depth 6 `
  --resume
```

### 登录授权

当 `crawl/auth-requirements.json` 表明存在登录门槛时，先向用户报告站点实际要求的账号字段、密码、验证码、扫码或第三方登录方式。

不要要求用户在聊天中发送密码、验证码、Cookie 或访问令牌。使用有界面的浏览器完成授权：

```powershell
node scripts/capture_auth_state.mjs `
  --url "https://example.com/login" `
  --out ".web-rebuild-private/auth-state.json" `
  --channel chrome
```

用户在打开的浏览器中完成密码、二维码、短信验证码或 CAPTCHA 后，再保存会话状态并继续：

```powershell
node scripts/reverse_site.mjs `
  --url "https://example.com/" `
  --out ".web-rebuild-output/example" `
  --storage-state ".web-rebuild-private/auth-state.json" `
  --max-pages 1000 `
  --max-depth 6 `
  --resume
```

`.web-rebuild-private/auth-state.json` 属于敏感凭据，不能提交、上传或写入模型上下文。

## 输出结构

```text
.web-rebuild-output/example/
├── source/                  已导出的静态资源
├── recovered-sources/       从 Source Map 恢复的源码
├── runtime/                 DOM、网络、样式和技术栈证据
├── screenshots/             原站截图
├── route-samples/           不同路由类型的代表页面
├── crawl/
│   ├── state.json           可恢复爬取状态和 URL 队列
│   ├── site-graph.json      页面节点和链接边
│   ├── route-coverage.json  路由模板覆盖
│   ├── api-contracts.json   脱敏响应结构
│   ├── auth-requirements.json 登录字段和挑战类型
│   ├── interaction-map.json 交互控件分类
│   └── unresolved.json      失败、登录阻塞和剩余队列
├── inventory.json           首页摘要
├── provenance.json          资源来源和哈希
├── rebuild-plan.json        实现阶段和缺口
└── rebuild-brief.md         可读的重建简报
```

## 脚本

| 脚本 | 作用 |
| --- | --- |
| `scripts/reverse_site.mjs` | 单入口完整流水线 |
| `scripts/inventory_site.mjs` | 单页资源、样式、DOM、网络和技术栈探测 |
| `scripts/crawl_site.mjs` | 可恢复全站爬取、接口结构和登录分析 |
| `scripts/sample_routes.mjs` | 每类路由抽样并保存 DOM、截图和摘要 |
| `scripts/capture_auth_state.mjs` | 有界面的授权登录和会话状态保存 |
| `scripts/plan_rebuild.mjs` | 从证据生成实现计划和缺口清单 |
| `scripts/compare_sites.mjs` | 原站与本地站视觉、结构和交互对比 |

## 完成标准

只有当以下条件全部满足时，才把逆向任务标记为完成：

- 当前范围内的 URL 队列为空。
- 没有未解释的请求失败或登录阻塞。
- 每类在范围内的路由都有代表证据和本地实现。
- 表单、筛选、分页、弹窗、播放器或应用操作等关键状态已经验证。
- 资源引用可在本地解析，或明确标注为第三方依赖。
- 已知接口都有本地契约、用户控制的适配器或显式模拟实现。
- 原站与本地站在约定的路由、视口和交互矩阵上通过验证。

仅有页面截图或抽样页面，不等于全站完成。

## 安全与合规

- 仅处理用户有权访问和重建的站点与账号。
- 不绕过登录、付费、DRM、CAPTCHA、限流或其他访问控制。
- 不重放会改变生产状态的请求。
- 不保存 Cookie、授权头、密码、验证码、请求正文或个人数据。
- 对主题、字体、图片、影片内容和第三方脚本进行独立授权审查。
- 不把公开可访问等同于允许再分发。

## 验证

当前版本已经完成：

- 7 个脚本的 Node.js 语法检查。
- Skill 结构和 frontmatter 校验。
- 真实服务端渲染媒体站点的首页、详情页、列表页和六类路由抽样。
- 跨域 CSS 与字体依赖闭包。
- 登录页字段和验证方式识别。
- API 响应结构脱敏。
- 相同 URL 自比较达到 0% 像素差异和 0 个自动问题。

针对大型站点的 12 页有限测试保留了 199 个待继续 URL，并正确输出 `evidence-incomplete`，没有被标记为全量完成。

## 许可

使用目标网站代码、内容、图片和媒体前，请确认相应授权。本仓库未声明对目标网站内容或第三方资源的再分发许可。

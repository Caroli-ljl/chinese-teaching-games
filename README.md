# 中文教学游戏 · 李佳路 Caroli 作品集

> 一个**静态前端 + CloudBase 云端**混合架构的中文教学产品作品集：7 款可试玩互动教学游戏、AI 学情闭环、HSKK 易错发音档案等。
> 本仓库是站点的**源码**，可通过 GitHub Pages 托管为可在线访问的站点。
> 线上地址（GitHub Pages）：`https://Caroli-ljl.github.io/chinese-teaching-games/`
>
> ⚠️ 本仓库依作者意愿**仅含作品集内容**：`works.html` + `games/`（7 款可试玩互动原型）+ 配套前端代码与云函数源码。首页 `index.html` 与简历 `resume.html` 未纳入本仓库。

---

## 一、整体架构

| 部分 | 说明 | 在 GitHub Pages 上 |
| --- | --- | --- |
| 静态页面 | `works.html`（作品集单页） | ✅ 直接可用 |
| 纯客户端小游戏 | `games/pinyin-wheel`、`games/qing-family-wheel`、`games/kan-tu-xuan-pinyin`、`games/hanzi-pintu`、`games/hanzi-unit-match` | ✅ 直接可用（无需后端） |
| 云端增强功能 | 智能汉字词卡、HSKK 档案、学情看板、联机对战 | ⚠️ 依赖原 CloudBase 环境（见下） |

云端增强功能通过前端匿名直连 **CloudBase**（环境变量 `ENV_ID` + 匿名 `ACCESS_KEY`）调用云函数：
`contentApi` / `hskkApi` / `hanziApi` / `sentenceArchiveApi`。
只要原 CloudBase 环境保持在线，这些功能在 Pages 站点上同样可用。

---

## 二、每个组件说明

### 2.1 作品集页面

| 文件 | 作用 | 说明 |
| --- | --- | --- |
| `works.html` | **作品集单页** | 三大 Tab：① 课堂互动产品体系（含「教学交互原型库」7 款游戏面板）；② AI 学情闭环（教师端学情看板 + HSKK 易错发音档案）；③ 产品思考。全站内容编辑系统入口亦在此。 |

> 注：作者另有独立的**首页 `index.html`** 与**简历 `resume.html`**，按作者意愿**未纳入本仓库**，本仓库只收录作品集内容。

### 2.2 七款互动教学游戏（`games/`，HTML + `lib/`）

| # | 名称 | 文件 | 一句话定位 | 教学价值 |
| --- | --- | --- | --- | --- |
| 1 | **看图选拼音** | `games/kan-tu-xuan-pinyin.html` | 拼音认读 · 零基础游戏化入口 | 用 emoji 跨语言视觉锚点降低认知门槛，把「图像→汉字→拼音」三联映射做成有节奏、有反馈的游戏；三档难度、连击/限时计分、即时发音+释义反馈；支持双人对战与云端战绩。 |
| 2 | **识字消消乐 · 分单元版** | `games/hanzi-unit-match.html` | 分单元词库 · 贴合教材进度 | 在消消乐内核上升级「分单元」词库（数字/人称/亲属/学校/饮食/颜色/动作/自然 8 单元），让教师对应教材进度布置练习；支持自定义词库与联机对战。 |
| 3 | **青字家族大转盘** | `games/qing-family-wheel.html` | 形声字字族 · 规律发现式教学 | 用转盘把「声旁表音、形旁表义」变成可玩的规律发现，直观展示青字族（清/晴/请/情/蜻/睛/静/精/靖/菁），承载形声字教学法。 |
| 4 | **拼音大转盘** | `games/pinyin-wheel.html` | 拼音三档 · 随机暴露抗遗忘 | 「转盘+听音选择」用随机性制造重复暴露，比死记硬背更抗遗忘；声母/韵母/整体认读三档可切，适配课堂随机点将。 |
| 5 | **智能汉字词卡** | `games/hanzi-wordcard.html` | AI 词卡 · 多模态生成 + 共享汉字表 | 输入汉字即调用 Coze 工作流生成含图片/发音/例句/翻译的多模态词卡；学生自生成组成全班共享汉字表，数据沉淀云端供教师统一进度与学情分析。 |
| 6 | **Coze 飞书句子错误档案** | `games/coze-sentence-archive.html` | AI 批改 + 飞书沉淀 · 错题可追溯 | 先由 Coze 生成情景图辅助看图说话造句，再即时批改，错误自动回流飞书多维表格形成可复盘档案；把课堂纠错从「滞后」变「即时+可复盘」。（⚠️ 演示版，AI 批改依赖 Coze 额度） |
| 7 | **汉字拼图** | `games/hanzi-pintu.html` | 部件拼字 · 形义拆解游戏化 | 拖拽偏旁部件拼出目标字，配拼音/释义/即时发音；难度可选、支持自定义词库与教师出题；连击计分 + S/A/B/C 评级 + 错题回顾 + 云端擂台存分。 |

> 纯客户端游戏（1/2/3/4/7）在 GitHub Pages 上**开箱即玩**；云端增强游戏（5/6）及联机/战绩功能需 CloudBase 环境在线。

### 2.3 云端函数（`cloudfunctions/`，源码存档，运行在 CloudBase）

| 云函数 | 作用 | 依赖的环境变量（部署时设置，不进仓库） |
| --- | --- | --- |
| `contentApi` | 全站内容编辑系统的读写（按 `ckey` 覆盖静态文案） | `CONTENT_PASSCODE`（编辑口令） |
| `hskkApi` | HSKK 易错发音档案：分页拉飞书表格、脱敏、按维度分类 | `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_APP_TOKEN` / `FEISHU_TABLE_ID` |
| `hanziApi` | 智能汉字词卡：Coze 生成词卡 + 生词表增删查改 | CloudBase 环境内置 |
| `sentenceArchiveApi` | Coze 飞书句子错误档案：生词→情景图、句子→批改+飞书存档 | 依赖 Coze / 飞书额度 |

### 2.4 配置与部署文件

| 文件 | 作用 |
| --- | --- |
| `config.js` | **占位符配置**（部署时由 GitHub Secrets 注入真实 `ENV_ID` / `ACCESS_KEY`），密钥从不进源码。 |
| `config.example.js` | 本地预览模板（复制为 `config.local.js` 并填值，已被 `.gitignore` 排除）。 |
| `content.js` | 全站内容编辑系统前端（Ctrl+Shift+E 进入编辑，口令校验）。 |
| `assets/` | 图片等静态资源（`avatar.jpg`、`wordcloud2.js`、`pinyin-pro.min.js` 等）。 |
| `.github/workflows/deploy.yml` | Pages 部署流水线：拉取 Secrets → 注入 `config.js` → 部署到 GitHub Pages。 |
| `.nojekyll` | 关闭 Jekyll，确保静态资源原样托管。 |
| `publish.sh` | 一键发布助手：登录校验、建仓/加 remote、推送、设 Secrets、启用 Pages。 |

---

## 三、隐私与安全（重要）

- 本仓库**不包含任何真实密钥**。所有敏感值（CloudBase `ACCESS_KEY`、内容编辑口令、飞书凭据）都已从源码移除。
- 真实值通过 **GitHub 仓库 Secrets** 在部署时注入 `config.js`，**不进代码、不进 git 历史**。
- `ACCESS_KEY` 是 CloudBase 设计上就放在前端的**匿名可公开**密钥；但为防滥用，部署到 Pages 后建议到 CloudBase 控制台**轮换该 key** 使其失效，并收紧匿名安全规则（关闭匿名写敏感数据）。
- 本地预览用的 `config.local.js` 已被 `.gitignore` 排除，切勿将其提交。

---

## 四、本地预览

```bash
cp config.example.js config.local.js   # 填入你自己的 ENV_ID / ACCESS_KEY
# 直接用浏览器打开 works.html 即可（无需构建）
```

> `config.local.js` 不会被提交；CI 部署走的是仓库 Secrets 注入，与本地文件互不影响。

---

## 五、部署到 GitHub Pages

### 1. 准备仓库 Secrets
仓库 **Settings → Secrets and variables → Actions** 添加：

| Name | 说明 |
| --- | --- |
| `ENV_ID` | CloudBase 环境 ID（如 `cloud-chinesegame-xxxx`） |
| `ACCESS_KEY` | CloudBase 匿名 publishable key（JWT） |

### 2. 一键发布
```bash
gh auth login                              # 浏览器/设备码登录（首次需此步）
cd jialu-site
bash publish.sh                            # 建仓(若需)/推送/设 Secrets/启用 Pages
```

### 3. 启用 Pages
若 `publish.sh` 未能自动启用：仓库 **Settings → Pages → Source 选 GitHub Actions** 保存即可。
访问 `https://<用户名>.github.io/chinese-teaching-games/` 验证。

> ⚠️ **私有仓库 + Pages 的套餐限制**：GitHub 免费个人账号仅支持「公开仓库的 Pages」。
> 若你的账号是免费档且想保留私有仓库，需要 GitHub Pro / Team 才能开启私有仓库 Pages；
> 若不想升级，把仓库设为 Public 也**不影响隐私**——因为真实密钥从不进仓库（已改用 Secrets 注入）。

---

## 六、备注

- 站点全部使用**相对路径**，因此托管在 GitHub Pages 子路径（`/chinese-teaching-games/`）不会 404。
- `cloudfunctions/` 仅为后端源码存档，不参与 Pages 静态部署；它们运行在 CloudBase 上。

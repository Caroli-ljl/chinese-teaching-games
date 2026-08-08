# 李佳路 Caroli · AI 产品经理作品集

> 一个**静态前端 + CloudBase 云端**混合架构的作品集站点：课堂互动游戏、AI 学情闭环、HSKK 易错发音档案等。
> 本仓库是站点的**源码**，通过 GitHub Pages 托管为可在线访问的站点。

---

## 架构速览

| 部分 | 说明 | 在 GitHub Pages 上 |
| --- | --- | --- |
| 静态页面 | `index.html` / `works.html` / `resume.html` | ✅ 直接可用 |
| 纯客户端小游戏 | `games/pinyin-wheel`、`games/qing-family-wheel`、`games/kan-tu-xuan-pinyin` | ✅ 直接可用（无需后端） |
| 云端增强功能 | 智能汉字词卡、简历编辑、HSKK 档案、学情看板、联机对战 | ⚠️ 依赖原 CloudBase 环境（见下） |

云端增强功能通过前端匿名直连 **CloudBase**（环境变量 `ENV_ID` + 匿名 `ACCESS_KEY`）调用云函数：
`contentApi` / `resumeApi` / `hskkApi` / `hanziApi` / `sentenceArchiveApi`。
只要原 CloudBase 环境保持在线，这些功能在 Pages 站点上同样可用。

---

## 隐私与安全（重要）

- 本仓库**不包含任何真实密钥**。所有敏感值（CloudBase `ACCESS_KEY`、内容编辑口令、飞书凭据）都已从源码移除。
- 真实值通过 **GitHub 仓库 Secrets** 在部署时注入 `config.js`（见下方「部署」），**不进代码、不进 git 历史**。
- `ACCESS_KEY` 是 CloudBase 设计上就放在前端的**匿名可公开**密钥；但为防滥用，部署到 Pages 后建议到 CloudBase 控制台**轮换该 key** 使其失效，并收紧匿名安全规则（关闭匿名写敏感数据）。
- 本地预览用的 `config.local.js` 已被 `.gitignore` 排除，切勿将其提交。

---

## 本地预览

1. 复制模板：`cp config.example.js config.local.js`
2. 在 `config.local.js` 填入你自己的 `ENV_ID` / `ACCESS_KEY`
3. 直接用浏览器打开 `index.html` 即可（无需构建）

> `config.local.js` 不会被提交；CI 部署走的是仓库 Secrets 注入，与本地文件互不影响。

---

## 部署到 GitHub Pages

### 1. 准备仓库 Secrets

在 GitHub 仓库 **Settings → Secrets and variables → Actions** 中添加：

| Name | 说明 |
| --- | --- |
| `ENV_ID` | CloudBase 环境 ID（如 `cloud-chinesegame-xxxx`） |
| `ACCESS_KEY` | CloudBase 匿名 publishable key（JWT） |

### 2. 初始化并推送（首次）

```bash
cd jialu-site
git init
git add -A
git commit -m "initial commit: 作品集站点（静态前端 + CloudBase 云函数源码）"
gh repo create jialu-portfolio --private --source=. --remote=origin
git branch -M main
git push -u origin main
```

推送 `main` 后，GitHub Actions 会自动把 Secrets 注入 `config.js` 并部署到 Pages。

### 3. 启用 Pages

仓库 **Settings → Pages** → Source 选择 **GitHub Actions**，保存即可。
稍后访问 `https://<你的用户名>.github.io/jialu-portfolio/` 验证。

> ⚠️ **私有仓库 + Pages 的套餐限制**：GitHub 免费个人账号仅支持「公开仓库的 Pages」。
> 若你的账号是免费档且想保留私有仓库，需要 GitHub Pro / Team 才能开启私有仓库 Pages；
> 若不想升级，把仓库设为 Public 也**不影响隐私**——因为真实密钥从不进仓库（已改用 Secrets 注入）。

---

## 目录结构

```
jialu-site/
├── index.html / works.html / resume.html   # 三个主页面
├── config.js                               # 占位符配置（部署时由 Secrets 注入）
├── config.example.js                       # 本地预览模板
├── content.js                              # 全站内容编辑系统前端
├── assets/                                 # 图片等静态资源
├── games/                                  # 七款互动教学游戏（HTML + lib/）
├── cloudfunctions/                         # CloudBase 云函数源码（contentApi / resumeApi / hskkApi 等）
├── .github/workflows/deploy.yml            # Pages 部署流水线
└── .nojekyll                               # 关闭 Jekyll
```

---

## 备注

- 站点全部使用**相对路径**，因此托管在 GitHub Pages 子路径（`/jialu-portfolio/`）不会 404。
- `cloudfunctions/` 仅为后端源码存档，不参与 Pages 静态部署；它们运行在 CloudBase 上。

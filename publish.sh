#!/usr/bin/env bash
# 把作品集推到 GitHub 并启用 Pages（密钥通过 gh secret 注入，绝不写进脚本/仓库）
set -euo pipefail

# 解析 gh 路径（Windows 已装在 Program Files，其它平台用 PATH 中的 gh）
GH="$(command -v gh 2>/dev/null || echo '/c/Program Files/GitHub CLI/gh.exe')"

# 0) 必须先登录
"$GH" auth status >/dev/null 2>&1 || {
  echo "❌ 你还没登录 GitHub。请先运行下面这条并完成浏览器/设备码验证："
  echo "      gh auth login"
  echo "   登录成功后再运行本脚本： bash publish.sh"
  exit 1
}

cd "$(dirname "$0")"
git branch -M main

USER="$("$GH" api user --jq .login)"
REPO="chinese-teaching-games"
echo "👤 已登录为 GitHub 用户: $USER  →  目标仓库: $REPO"

# 1) 仓库已存在（你已在 GitHub 建好）则只加 remote；否则创建私有仓库
if git remote get-url origin >/dev/null 2>&1; then
  echo "ℹ️  remote origin 已存在，跳过创建"
elif "$GH" repo view "$USER/$REPO" >/dev/null 2>&1; then
  git remote add origin "https://github.com/$USER/$REPO.git"
  echo "ℹ️  远程仓库已存在，已添加 remote"
else
  "$GH" repo create "$REPO" --private --source=. --remote=origin \
    || git remote add origin "https://github.com/$USER/$REPO.git"
fi

# 2) 推送（若远程已有初始提交，先 rebase 再推，避免 non-fast-forward 被拒）
if git push -u origin main 2>/dev/null; then
  echo "✅ 已推送 main"
else
  echo "⚠️ 首次推送被拒绝（远程可能已有提交），尝试 rebase 后重试..."
  git pull origin main --rebase || true
  git push -u origin main
fi

# 3) 设置 Secrets（真实密钥只进 GitHub，不进仓库/历史）
read -r -p "请输入 CloudBase ENV_ID（如 cloud-chinesegame-xxxx）: " ENV_ID
read -r -s -p "请输入 CloudBase ACCESS_KEY（JWT，输入不回显）: " ACCESS_KEY
echo
"$GH" secret set ENV_ID --body "$ENV_ID"
"$GH" secret set ACCESS_KEY --body "$ACCESS_KEY"

# 4) 启用 Pages（使用 Actions 构建方式）
if "$GH" api -X POST "/repos/$USER/$REPO/pages" -f build_type=workflow >/dev/null 2>&1; then
  echo "✅ Pages 已启用（GitHub Actions 方式）"
else
  echo "⚠️ 无法自动启用 Pages（可能是免费账号不支持私有仓库 Pages）。"
  echo "   方案 A：到仓库 Settings → Pages → Source 选 GitHub Actions 并保存。"
  echo "   方案 B：把仓库设为 Public（密钥仍安全，因为从不进仓库）。"
fi

echo
echo "🎉 完成！稍后访问： https://$USER.github.io/$REPO/"
echo "   首次部署需等 Actions 跑完（约 1 分钟），可在 Actions 标签页查看进度。"

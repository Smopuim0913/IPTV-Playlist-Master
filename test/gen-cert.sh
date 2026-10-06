#!/usr/bin/env bash
# 生成自签名证书，供 test/tls.mjs 模拟「证书不可信的 IPTV 源站」用。
# Windows 上 Node 看到的 /tmp 和 Git Bash 的 /tmp 不是一回事，所以固定放在项目内 .tmp/。
set -e
cd "$(dirname "$0")/.."
mkdir -p .tmp
openssl req -x509 -newkey rsa:2048 -keyout .tmp/k.pem -out .tmp/c.pem -days 1 -nodes \
  -subj "/CN=wrong-host" 2>/dev/null
cat .tmp/k.pem .tmp/c.pem > .tmp/bundle.pem
echo "cert ready -> .tmp/bundle.pem"

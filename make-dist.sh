#!/bin/bash
# 生成可分发给他人的版本。
#
# 与个人版的唯一区别：去掉 @updateURL / @downloadURL。
# 那两行指向本机的 127.0.0.1:8899，别人装上去后 Tampermonkey 会
# 反复尝试从这个地址检查更新 —— 对方没跑这个服务，检查永远失败；
# 更糟的是万一对方本机 8899 端口有别的服务在跑，可能拉到不明内容。
#
# 用法：./make-dist.sh
# 产物：releases/bilibili-filter-v<版本>-dist.user.js
set -euo pipefail

cd "$(dirname "$0")"

SRC="bilibili-filter.user.js"
VER=$(grep -m1 '^// @version' "$SRC" | awk '{print $3}')
OUT="releases/bilibili-filter-v${VER}-dist.user.js"

mkdir -p releases

# 删掉两行本地更新地址
grep -vE '^// @(updateURL|downloadURL)\s+http://127\.0\.0\.1' "$SRC" > "$OUT"

echo "已生成: $OUT"

# 校验：必须没有残留的本地地址
if grep -qE '127\.0\.0\.1|localhost' "$OUT"; then
  echo "错误：产物里仍有本地地址引用" >&2
  grep -nE '127\.0\.0\.1|localhost' "$OUT" >&2
  exit 1
fi

# 校验：语法合法
node --check "$OUT"

# 校验：版本号一致
OUTVER=$(grep -m1 '^// @version' "$OUT" | awk '{print $3}')
if [ "$VER" != "$OUTVER" ]; then
  echo "错误：版本号不一致 $VER vs $OUTVER" >&2
  exit 1
fi

echo "  版本   : $VER"
echo "  字节   : $(wc -c < "$OUT")"
echo "  本地引用: 无"
echo "  语法   : OK"
echo
shasum -a 256 "$OUT"

#!/bin/bash
# 把 bilibili-filter.user.js 更新到 Chrome 里的 Tampermonkey。
#
# 为什么不能全自动：Tampermonkey 把脚本存在 Chrome 的 LevelDB 里，Chrome
# 每次启动都会把旧 log 合并进压缩的 SSTable。外部写入要么被静默丢弃（写成功
# 但加载旧版），要么被扩展在下次启动时用自己缓存的那份覆盖回去。实测多次
# 后确认：唯一可靠的方式是走它自己的安装流程，由用户在安装页点一次确认。
#
# 用法：./deploy.sh   然后在新开的标签页点 Update
set -euo pipefail

cd "$(dirname "$0")"

PORT=8899
URL="http://127.0.0.1:${PORT}/bilibili-filter.user.js"

echo "== 1/3 检查本地服务 =="
if ! curl -s --max-time 2 -o /dev/null "$URL"; then
  echo "   服务没在跑，启动中…"
  launchctl kickstart -k "gui/$(id -u)/com.kent.blfserve" 2>/dev/null || {
    echo "   无法启动 com.kent.blfserve，尝试直接运行 serve.py"
    python3 serve.py
  }
  sleep 2
fi
# 只取版本号这一行。
# 用 grep 锁 @version，不靠行号 —— 头部元数据行数会随文案调整而变，
# 写死第 4 行迟早取到错的内容。
# 也不能直接 `curl | head -4` —— 脚本开了 pipefail，head 读够就关闭管道，
# curl 收到 SIGPIPE 返回非 0，pipefail 把这个当失败直接退出脚本。
# 文件小时碰巧一次写完不触发，超过管道缓冲区就必现（改成 100KB 后踩到）。
curl -s --max-time 2 "$URL" 2>/dev/null | grep -m1 '^// @version' || true

echo "== 1.5/3 编码自检 =="
CT=$(curl -sI "$URL" | tr -d '\r' | grep -i '^content-type:')
case "$CT" in
  *charset=utf-8*|*charset=UTF-8*)
    echo "   OK  $CT"
    ;;
  *)
    echo "   警告：服务端 Content-Type 没带 charset=utf-8" >&2
    echo "         实际返回：$CT" >&2
    echo "         Tampermonkey 会按 Latin-1 解码，脚本里的中文全变乱码。" >&2
    echo "         请确认 serve.py 里的 guess_type() 已生效，然后：" >&2
    echo "           launchctl kickstart -k gui/$(id -u)/com.kent.blfserve" >&2
    exit 1
    ;;
esac

# 逐字节验证下载内容确实是合法 UTF-8，且中文没坏
curl -s "$URL" | python3 -c '
import sys
raw = sys.stdin.buffer.read()
try:
    s = raw.decode("utf-8")
except UnicodeDecodeError as e:
    print("   错误：下载内容不是合法 UTF-8：", e, file=sys.stderr)
    sys.exit(1)
if "档位" not in s or "震惊" not in s:
    print("   错误：脚本中文内容异常，检出规则可能失效", file=sys.stderr)
    sys.exit(1)
print("   中文校验通过（%d 字节）" % len(raw))
' || exit 1

echo "== 2/3 打开安装页 =="
open "https://www.tampermonkey.net/script_installation.php#url=${URL}"

echo "== 3/3 等待确认 =="
cat <<'MSG'

已打开 Tampermonkey 的更新页。请在那个标签页点一下「Update」，
脚本就会换成本地这份最新版本。

页面右侧会显示：
  INSTALLED VERSION  当前装着的版本
  顶部标题旁        要装的新版本
两者一致即已更新。装好后刷新 B 站页面，右下角徽章会带上版本号。
MSG

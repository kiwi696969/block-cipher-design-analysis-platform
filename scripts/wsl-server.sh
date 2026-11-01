#!/usr/bin/env bash
# ===================================================================
#  密码算法分析系统 —— 在 WSL 里启动 Django（含「后端搜索」的 BCA_Light）
#
#  入口是项目根目录的 start-platform-wsl.bat（双击即用）。
#  本脚本由它调用，也可以在项目根目录直接 `bash scripts/wsl-server.sh`。
#
#  为什么 Django 要跑在 WSL 里
#  ---------------------------
#  「后端搜索」页依赖 BCA_Light，而 BCA 的 bca/solver.py 用 ctypes 调 libc 的
#  PR_SET_PDEATHSIG 防孤儿进程（Linux 专属），kissat 也是 ELF 二进制 ——
#  Windows 原生跑不了。把 Django 一起搬进 WSL，两者就变成同一个系统里的
#  本地子进程调用，不必跨 wsl.exe（那条边界上本项目实测撞过 5 类故障：
#  僵尸 VM、UTF-16LE 编码、/mnt/c 路径转换、SIGTERM 掐断、沙箱拦程序）。
#
#  代码只有一份：WSL 里仍然读 Windows 上这个项目目录（经 /mnt/c），
#  不存在"两边不同步"的问题。前端产物 static/dist 直接复用，WSL 不用装 Node。
#
#  可用环境变量覆盖：PORT（默认 8011）、HOST（默认 0.0.0.0）、NORELOAD、
#  BCA_KISSAT（kissat 路径；不设则用 config.json 的 solver.path，再退 PATH /
#  项目自带副本）。BCA_KISSAT 会被 Django 与 BCA 子进程逐层继承。
# ===================================================================

set -uo pipefail

# 本脚本在 <项目>/scripts/ 下，向上一级就是项目根
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR" || exit 1

# 站点配置（SECRET_KEY / DEBUG / 主机名单）从这里读。
# 这个文件**不进版本库**，所以密钥不会被提交；把 wsl-env.sh.example 复制成
# wsl-env.sh 就生效。不存在时用源码里的开发默认值，行为与以前完全一样。
if [ -f "$PROJECT_DIR/scripts/wsl-env.sh" ]; then
  # shellcheck disable=SC1091
  . "$PROJECT_DIR/scripts/wsl-env.sh"
fi

PORT="${PORT:-8011}"
HOST="${HOST:-0.0.0.0}"
NORELOAD="${NORELOAD:-1}"

BCA_DIR="$PROJECT_DIR/backend/bca_light"
MANIFEST="$PROJECT_DIR/static/dist/.vite/manifest.json"

ok()   { printf '  [ OK ] %s\n' "$1"; }
warn() { printf '  [WARN] %s\n' "$1"; }
bad()  { printf '  [FAIL] %s\n' "$1"; }

echo
echo "=========================================================="
echo "  密码算法分析系统  ——  Django + 后端搜索 (WSL)"
echo "=========================================================="
echo

# ---------------------------------------------------------------- 环境自检

echo "环境自检"
echo "----------------------------------------------------------"

if command -v python3 >/dev/null 2>&1; then
  ok "python3 $(python3 -V 2>&1 | awk '{print $2}')"
else
  bad "找不到 python3"
  echo "       安装：sudo apt install python3 python3-pip"
  exit 1
fi

if python3 -c "import django" >/dev/null 2>&1; then
  ok "Django $(python3 -c 'import django; print(django.get_version())')"
else
  bad "Django 未安装（或不在当前解释器里）"
  echo "       pip install --break-system-packages Django==6.1.1 django-simpleui"
  exit 1
fi

if [ -f "$MANIFEST" ]; then
  ok "前端已构建（static/dist/.vite/manifest.json）"
else
  warn "前端还没构建 —— 页面会显示「前端未构建」，但接口仍然可用"
  echo "       在 Windows 上双击 build-frontend.bat 构建一次即可"
fi

# ---------------------------------------------------------------- 站点配置
#
# 这里只做"看得出问题"的提示，不拦截启动 —— 配置不对时页面仍然能打开，
# 让人先看到站点，比直接拒绝启动更有用。

echo
echo "站点配置"
echo "----------------------------------------------------------"
if [ -n "${DJANGO_SECRET_KEY:-}" ]; then
  ok "SECRET_KEY 来自环境变量（不是源码里的开发默认值）"
else
  warn "SECRET_KEY 用的是源码里的开发默认值 —— 演示无妨，正式部署必须覆盖"
  echo "       复制 scripts/wsl-env.sh.example 为 scripts/wsl-env.sh 后填写"
fi

case "$(printf '%s' "${DJANGO_DEBUG:-1}" | tr 'A-Z' 'a-z')" in
  0|false|no|off)
    if python3 -c 'import whitenoise' >/dev/null 2>&1; then
      ok "DEBUG 已关闭，静态文件交给 whitenoise（不必先 collectstatic）"
    else
      bad "DEBUG 已关闭，但没装 whitenoise —— 前端资源会 404、页面整片白屏"
      echo "       二选一：pip install --break-system-packages whitenoise"
      echo "               或先 python3 manage.py collectstatic --noinput，再用 --insecure 启动"
    fi
    ;;
  *)
    ok "DEBUG 开启（开发/演示形态：runserver 直接托管 static/）"
    ;;
esac

if [ -n "${DJANGO_ALLOWED_HOSTS:-}" ]; then
  ok "ALLOWED_HOSTS 由环境变量指定：${DJANGO_ALLOWED_HOSTS}"
else
  warn "ALLOWED_HOSTS 未指定（DEBUG 下为 *，否则为 127.0.0.1/localhost）"
fi

# BCA 只在 Linux 里能跑，所以这里只提示、不拦截：
# 后端搜索用不了不影响平台其余部分。
echo
echo "后端搜索（BCA_Light）"
echo "----------------------------------------------------------"
if [ -f "$BCA_DIR/bca_entry.py" ]; then
  ok "入口脚本 $BCA_DIR/bca_entry.py"
else
  warn "找不到 $BCA_DIR/bca_entry.py —— 后端搜索会报「BCA 入口脚本不存在」"
fi

# 判定顺序必须与 bca/config.py 的 resolve_solver_path 一致，否则自检会说谎：
# BCA_KISSAT > PATH 里的 kissat > 项目自带副本（config.json 的绝对路径只是默认值之一）
if [ -n "${BCA_KISSAT:-}" ]; then
  if [ -x "$BCA_KISSAT" ]; then
    ok "kissat 由环境变量 BCA_KISSAT 指定（$BCA_KISSAT）"
  else
    warn "BCA_KISSAT=$BCA_KISSAT 不存在或不可执行 —— 后端搜索会失败"
    echo "       改正：export BCA_KISSAT=/正确的/kissat 后再启动；或 unset BCA_KISSAT 回到默认"
  fi
elif command -v kissat >/dev/null 2>&1; then
  ok "kissat 在 PATH 里（$(command -v kissat)）"
elif [ -x "$PROJECT_DIR/kissat-4.0.0-linux-amd64/kissat-4.0.0-linux-amd64" ]; then
  ok "用项目自带 kissat（kissat-4.0.0-linux-amd64/，随代码分发）"
else
  warn "没找到 kissat —— SAT 求解器缺失，后端搜索跑不起来"
  echo "       装一个：install -m 755 \\"
  echo "         \"$PROJECT_DIR/kissat-4.0.0-linux-amd64/kissat-4.0.0-linux-amd64\" ~/.local/bin/kissat"
  echo "       或指定：BCA_KISSAT=/path/to/kissat bash scripts/wsl-server.sh"
fi

if python3 -c "import pysat" >/dev/null 2>&1; then
  ok "python-sat 已安装"
else
  warn "python-sat 未安装（pip install --break-system-packages python-sat）"
fi

# ---------------------------------------------------------------- 端口

echo
echo "监听端口"
echo "----------------------------------------------------------"

if ss -ltn 2>/dev/null | grep -q ":${PORT}[[:space:]]"; then
  bad "端口 ${PORT} 已被占用 —— 可能已经有一个服务在跑"
  echo "       先停掉它，或换个端口：PORT=8012 bash scripts/wsl-server.sh"
  exit 1
fi
ok "端口 ${PORT} 空闲"

WSL_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

# ---------------------------------------------------------------- 访问方式

echo
echo "=========================================================="
echo "  服务地址"
echo "----------------------------------------------------------"
echo "  本机浏览器  ->  http://127.0.0.1:${PORT}/"
if [ -n "$WSL_IP" ]; then
  echo "  兜底通道    ->  http://${WSL_IP}:${PORT}/"
  echo "                  (WSL2 的 localhost 转发偶发失效时用这一条)"
fi
echo
echo "  后端搜索页  ->  http://127.0.0.1:${PORT}/bca/"
echo "  接口自检页  ->  http://127.0.0.1:${PORT}/check/"
echo "  后台        ->  http://127.0.0.1:${PORT}/admin/"
echo "----------------------------------------------------------"
if [ "$NORELOAD" = "1" ]; then
  echo "  自动重载已关闭（改了后端 Python 代码需重启本脚本）。"
  echo "  演示时这样更稳：不会因为误碰文件把正在跑的搜索打断。"
  echo "  开发时想看自动重载：NORELOAD=0 bash scripts/wsl-server.sh"
else
  echo "  自动重载已开启（改动 .py 后服务会自动重启）。"
fi
echo "  停止服务：Ctrl + C"
echo "=========================================================="
echo

# ---------------------------------------------------------------- 启动
#
# 刻意**不用 exec**：exec 会把本进程换成 python，服务停掉时 shell 已经不在了，
# 没法打印收尾信息。让 shell 留到最后还有一个好处 —— 输出职责清晰：
# 所有诊断信息都由这一侧打印，bat 只在启动前说一句。两个进程交替写同一个
# 重定向句柄时会互相覆盖（cmd 与 wsl.exe 各持一个文件位置），只在启动前写就绕开了。

if [ "$NORELOAD" = "1" ]; then
  python3 manage.py runserver "$HOST:$PORT" --noreload
else
  python3 manage.py runserver "$HOST:$PORT"
fi
RC=$?

echo
echo "=========================================================="
echo "  服务已停止（退出码 ${RC}）。这个窗口可以关掉了。"
echo "=========================================================="
exit "$RC"

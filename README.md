# 密码算法分析系统（BCA_Light）

面向分组密码的**差分 / 线性自动化分析平台**：在浏览器里拖出轮函数结构，交给后端 SAT/MILP 求解器逐轮搜索概率最优的特征，并给出权重、活跃 S 盒、变量/子句规模与收敛过程。

目标是让「改一个轮函数，看它抗差分/线性分析到底有多强」这件事，从改脚本、跑几天、读日志，变成一个可以在几分钟内重复的实验。

---

## 能做什么

- **拖拽式结构编辑器**：11 类节点（输入 / 输出 / S 盒 / 线性层 / 轮密钥异或 / 置换 / 拆分 / 合并 / 转置 / 四分之一轮 / 整轮），拖出来即是一份可执行模型，右侧同步生成中文解析。
- **逐轮精确判定**：后端 BCA 逐轮求最小概率权重 $-\log_2 p$，SM4 前 8 轮为 `0, 0, 0, 6, 12, 12, 30, 38`（与公开结果一致）。
- **四个求解模型族**：双权优化（DW）、最小双权（MDW）、活跃 S 盒（AS）、概率映射（MAP），并支持倒序 / 并行两种正交搜索策略。
- **建模规模可测**：每一轮都给出变量数与子句数，规模增长不再是黑箱。
- **过程可见**：收敛曲线、逐轮明细、路径明细、运行日志；结果落盘为 CSV，断点续跑靠它。
- **多方案对比**：最多 3 份结果并排比较，自动标注数值来源（精确判定 / 上界）。

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 后端框架 | Django 6.1 | 单进程，同时提供 API 与前端产物托管（8011 端口） |
| 前端 | Vue 3.5 + Vite 8（多页应用） | **不是 SPA**：每个页面一个 HTML 根文件、一个构建入口、一条 Django 路由 |
| 求解器 | kissat（SAT） / Gurobi（MILP） | 经 `backend/bca_light/bca_entry.py` 以 stdin/stdout JSON 协议接入 |
| 运行时 | Python 3.13 / Node 22 | 求解器部分依赖 Linux（见下文） |

```
浏览器 ──► Django :8011 ──► analysis/views.py ──► bca_bridge.py ──► bca_entry.py ──► kissat / Gurobi
              │                                                          │
              └── static/dist（Vite 构建产物）                            └── results/<task>/<算法>/<模型>/*.csv
```

## 快速开始

### 1. 装依赖

```bash
python -m venv .venv
.\.venv\Scripts\activate          # Windows
pip install -r requirements.txt

cd frontend && npm install && npm run build && cd ..
```

### 2. 起服务

```bash
python manage.py migrate
python manage.py runserver 127.0.0.1:8011
```

打开 <http://127.0.0.1:8011/>。

> 前端产物没构建时页面会整片 404 —— 先 `npm run build`，再刷新。

### 3. 启用「后端搜索」（可选）

`/bca/` 页面与各分析页的精确数值依赖 BCA 后端，它有两个前提：

1. **Linux 环境**。BCA 通过 `ctypes` 调用 `prctl(PR_SET_PDEATHSIG)` 防止孤儿进程，kissat 也是 ELF 二进制，Windows 原生跑不起来。推荐 WSL2。
2. **求解器就位**：
   - **kissat**：自行获取 4.0.0 的 linux-amd64 版本，放到 PATH 或项目根目录，或用 `BCA_KISSAT` 环境变量指定。
   - **Gurobi**：需要自备 **13.0** 的安装与许可证（MILP 模型用）。仓库**不包含** `libgurobi130.so`——商业许可不允许分发，请从官方渠道安装后设置 `GRB_LICENSE_FILE`。

项目根目录的 `start-platform-wsl.bat` 会把 Django 一并放进 WSL 启动（代码仍读同一份目录），避免跨 `wsl.exe` 边界带来的编码与进程管理问题。

## 测试

```bash
cd frontend
npm test                # 纯 Node 回归套件，无需浏览器（引擎基准 / 参数装配 / 集成 / 多页结构 / 种子一致性 / 精度复核）
npm run test:e2e        # 真实浏览器 E2E（需后端已在 8011 运行）
```

后端另有 Django 测试：`python manage.py test`。

回归套件的重点不是覆盖率，而是**锁住数值**：SM4 的逐轮基准、S 盒与 LAT 的独立重算、真实加密抽样复核——改引擎前先跑，红了就不要往下改。

## 目录结构

```
analysis/           Django 业务应用：页面注册表 pages.py、视图、BCA 桥接
cipher_platform/    工程配置（环境变量读 SECRET_KEY / DEBUG / ALLOWED_HOSTS）
backend/bca_light/  BCA 后端本体：bca/（SAT 引擎）、models/（DW/MDW/AS/MAP）、data/（S 盒常量）
frontend/           Vite 工程：13 个 HTML 入口、views/、core/（纯计算层，可脱离浏览器跑）、tests/
templates/          每页一个根模板
static/dist/        前端构建产物（构建生成，不入库）
scripts/            WSL 启动与部署脚本（wsl-env.sh.example 为配置模板）
docs/               铁律案例史、变更流水
AGENTS.md           面向 AI 助手与协作者的工程约定（含踩坑清单）
```

## 已知限制

- **PRESENT、类 AES 与自搭图目前没有后端实现**，只有 SM4 / AES / DBlock 系列 / Rijndael256 走后端精确判定；其余结构下方使用前端启发式搜索，其数值是**上界**而不是精确值。
- 单次搜索在工作线程上串行占用求解器锁，并发请求会跟随进行中的任务而不是并行开跑。
- 32 轮全空间搜索需要数小时，用于演示时应提前预热目标轮次；结果落盘在 `backend/bca_light/results/`（不入版本库），重启即用。

## 文档

- `AGENTS.md`：架构约定、端口、命令、以及一份很长的「踩过的坑」——想改代码先读它。
- `docs/铁律案例史.md`：关键缺陷的完整复盘。

## 许可与分发

本仓库代码版权归作者所有，**未附开源许可证**（All rights reserved）。如需引用或复用，请先联系作者。

**第三方组件不随仓库分发**：Gurobi 及其运行时库（`libgurobi130.so`）、kissat 二进制均需自行从官方渠道获取，并遵守各自的许可协议。

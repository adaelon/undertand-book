# Linux 阅读器数据迁入与服务配置

适用单用户源码部署；先停止两端对待迁入副本的写入。保留原目录作为备份，在显式选择的副本上操作。

## 迁入材料与私有数据

1. 复制完整书籍目录到 `/opt/understand-book/books`，包括隐藏 `.build`、PDF、图片、manifest、映射分片和附属产物。
2. 把 `UNDERSTAND_BOOK_MEMORY_DIR` 的内容复制到独立 memory 目录。该目录保存 memory、session、agent-history 及其他既有读者文件；整个目录一起复制。
3. 把 `UNDERSTAND_BOOK_PRIVATE_DIR` 的内容复制到独立 private 目录，以延续已有 accepted 目标成果。成果按既有 book/intent/artifact 身份与相对文件布局读取，无需替换成果正文中的路径文字。
4. 如有外部书籍索引，把原书库的 `library-registry.json` 复制到新书库根；索引引用的外部材料也需完整复制。
5. 编写目录对应文件并执行下面的预览，确认后对副本应用。再次应用同一映射不产生修改。

```json
{
  "E:\\books\\中文 空格": "/opt/understand-book/books/中文 空格",
  "C:\\papers\\paper-b": "/opt/understand-book/books/paper-b"
}
```

```bash
node scripts/linux/relocate-reader-paths.mjs \
  --memory-dir /opt/understand-book/data/memory \
  --library-root /opt/understand-book/books --map /opt/understand-book/directories.json

node scripts/linux/relocate-reader-paths.mjs \
  --memory-dir /opt/understand-book/data/memory \
  --library-root /opt/understand-book/books --map /opt/understand-book/directories.json --apply
```

脚本只重定位 `session.json.current_book_dir`、`session.json.books` 的目录键和 `library-registry.json.workspaces`。旧版 session 仅重定位 `book_dir`，保持原格式交给已有读取路径。冲突或缺少 Windows 目录映射时在任何写入前失败；不会用一份进度覆盖另一份。笔记正文、LID、book_id、画像和对话不做字符串替换。

## 常驻配置

先在最终源码路径安装依赖并构建，沿用 [LX1 工具链记录](Linux阅读器-LX1验收.md)。源码及 `node_modules` 保留在原编译位置。

```bash
pnpm install --frozen-lockfile
pnpm -C packages/web build
cargo build --locked --release -p server --bin server
```

以 [reader.env.example](../scripts/linux/reader.env.example) 为模板保存 `/opt/understand-book/reader.env`；将 `UNDERSTAND_BOOK_NODE` 改为实机 Node 绝对路径，LX1 为 `/opt/understand-book/tools/node-v24.20.0-linux-x64/bin/node`。填入模型配置，文件供 systemd 读取。目录变量由启动环境提供，不能依赖 Provider 延迟读取 `.env`。

创建或选择专用服务账户 `understand-book`，确保它能遍历源码、工具链和书库，读写两个私有目录；书库外部注册表需要相应写权限。新建账户和调整所有权应只针对已选定的部署目录。将 [unit](../scripts/linux/understand-book.service) 安装为 `/etc/systemd/system/understand-book.service`，按实际目录与账户调整后执行：

```bash
systemctl daemon-reload
systemctl enable --now understand-book
systemctl stop understand-book
systemctl start understand-book
journalctl -u understand-book -n 100
```

unit 通过 Bash 启动脚本，脚本 `exec` 进入 `server --reader-only`。SIGINT/SIGTERM 仅通知主线程，由正常控制流停止接单、等待在途工作、冲刷已读账本。Linux 纯阅读模型单次 HTTP 尝试上限 60 秒，已有最多一次重试；停止后不再开始下一次模型调用。统计辅助调用上限 30 秒，源码方式直接通过 Node `--import tsx` 执行，避免保留 tsx CLI 中间子进程。unit 的 180 秒停止窗口用于覆盖当前调用与持久化，强制结束不计为有序停止成功。

服务默认监听 `127.0.0.1:8787`；从 Windows 建立 SSH 隧道后访问本地 `18787`。后续更新材料使用“停止 → 同步完整目录 → 启动”，启动时沿用同一私有目录恢复书籍和阅读位置。

## 已知限制与验收状态

- 当前目标为 veLinux/CentOS 9 x86_64；只支持单 Reader 写一份私有数据。
- 本文提供实现后的操作入口，实机迁入、systemd 和在途停止结果见 [LX2–LX6 进展](Linux阅读器-LX2-LX6进展.md)。未取得的实机结果不表示已经部署完成。
- 预构建继续使用现有环境；正式学习的就绪约定沿用 ADR-0120。

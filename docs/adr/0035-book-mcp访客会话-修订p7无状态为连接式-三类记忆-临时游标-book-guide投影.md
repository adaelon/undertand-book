# ADR-0035 Book MCP 访客会话 —— 修订 P7 无状态为连接式 + 三类记忆 + 临时游标 + book_guide 投影

## 背景

ADR-0033 决策12 / 切片方案 §1.5.8 把 P7 Book MCP 冻结为**无状态只读**:外部 agent 自带 `anchor_lid`、自行导航,我们不给它"活的向导"。Grill 戳穿一个死结:外部 agent 拿到一条引导后说"**不对**",但无连接 = 无会话记忆 = 每次冷启动 = 无法收敛。**"引导"本质是迭代的**,纯无状态做不出引导。承 ADR-0034(route 两投影中的外部 agent 投影)。

## 决策

1. **记忆三分(澄清,此前只分两类是漏)**:
   ```
   ① 世界模型        公共,可借(route / book.text / citation gate)
   ② 读者私人记忆     durable + 读者所有 + 绝不外借(reader_profile / memory / viewport)  ← 私人房间
   ③ 访客会话记忆     ephemeral + 访客交互所有(它问了啥、我们返了啥、它的"不对")      ← 新的一类
   ```
   关键:**③ 不碰 ②**。给访客 session 记忆 ≠ 给它读者的任何东西。两者是两间不同的房,"私人房间不外借"与"访客要有会话记忆"不矛盾。

2. **修订 P7 无状态 → 连接式访客会话(TCP 式握手/挥手,仅作用于 Tier 2 book_guide,见决策7)**:
   ```
   握手 (SYN/ACK)   开连接,发 session_id,(可选)协商 book + 声明意图,分配 ③
   传输             迭代引导:访客问/refine("不对")→ agent 用 route + ③ 收敛 → 返下一步 → 更新 ③
   挥手 (FIN)       关连接,丢弃 ③(绝不写入 ② 的 durable memory store)
   keepalive/超时    GC 掉被遗弃的会话
   ```

3. **访客会话内容 = transcript + 临时游标**:
   ```ts
   VisitorSession {
     session_id; book_id; declared_intent?
     transcript: Exchange[]                              // query + 返回的 route/答案 + "不对"反馈
     cursor?: { at_lid; last_frontier: RankedStep[] }    // 访客自己的位置,≠ 读者 viewport(那是 ②)
     opened_at; last_active_at                            // 超时 GC 用
   }
   ```
   "不对" ⇒ agent 知道访客**在哪、上次给了哪些前沿分支** ⇒ "退回、换前沿的另一支",收敛远快于只读 transcript。

4. **访客 = 临时住户 lite**:有了游标,同一 `route` 机制 + 同一带读 loop **也能"带"访客**——和带人类是同一个循环。差别只剩:人类带读 = durable + reader_profile 教学整形(②);访客带读 = ephemeral + 纯结构(无 ②)。这闭合 ADR-0034 的"统一"。

5. **book_guide 投影(对外只读)**:`book_guide(intent, anchor?)` 返回 `意图 → 入口节点 → route 路线(每步理由 + 证据 LID)`。是 `book_query` 的姊妹——**query 返答案,guide 返路线**;P7 本就收 LLM 命令 `book_query`,guide 同构。会话态使其可跨调用 refine。

6. **红线不变**:访客够不到 `reader.*` / `memory.*` / 读者 viewport / 读者 session;③ 挥手即焚,**绝不写入 ② 的 durable store**;`book_guide` 返回全是真 LID / 真边,**外部可独立验证**。

7. **暴露分两层 + crate 边界 + 红线焊法(承 ADR-0034 两投影,OPEN③ 收口)**:连接式只该套在"引导"上,只读本就不需要会话——
   ```
   Tier 1 无连接·无状态只读   book_manifest/text/context/concept/query/synthesize
                              纯函数 over 只读基座,anchor_lid 进答案出,不建 VisitorSession
                              = 原 §1.5.8「无状态」面(对只读从来够用,Grill 死结只在引导)
   Tier 2 带会话·迭代引导     book_guide(intent, anchor?, session_id)
                              握手/挥手/GC + ③(cursor+transcript)只作用此层(决策2 专指此)
   ```
   - **crate 落点**:`route_from`/`route_to` = read-tools **Core**(P8,两投影共享的 mechanism);`book_guide` = runtime **lite LLM 命令**(`book_query` 姊妹,无状态 per-call,`session_ctx` 作入参注入,复用 query/synthesize mini-loop + route_*,**不复用住户 `run()`**——run() 硬接 ② viewport/memory + effects 可撤销,访客全不需要);VisitorSession 表 + 握手/挥手/GC = server `AppState`。"同一带读 loop"(决策4)在**共享 route_\* + 带读结构**层兑现,非字面共享 `run()` 函数。
   - **裸 route 不给访客(v1)**:住户拿裸 `book.route_*`(ADR-0034),访客只拿 curate 过的 `book_guide`(它内部调 route_* 组装路线);裸 route 给高级访客留「何时回头」。
   - **红线靠物理无路由**(非运行时权限判):访客 MCP dispatch 只含 `book.*` + `book_guide` 分支,**根本不接 reader/memory 分支**——访客即便构造 `reader.goto` 调用也无路可达,比软判更难绕。住户单会话与访客会话表在 `AppState` 物理分离。

## 命门

server 一旦持有访客状态,就有 **会话资源管理** 问题(并发访客、半开连接、会话泄漏)——这正是 TCP 自己栽过的坑。**超时 GC + 强制挥手是承重墙,不是可选项**。

## 否决

- **纯无状态 guide**(原 P7 §1.5.8):不能 refine,即背景里的死结。
- **对话式 agent-as-MCP**(把"住户"agent 整个暴露):模糊住户/访客界,私人房间(读者记忆、session)出现泄漏面;且对话式 NL 引导外部无法独立验证,等于把幻觉风险输出去。

## 何时回头

- 会话超时阈值 / 并发访客上限。
- 游标 `last_frontier` 存多深(全部前沿 vs 仅上次选中分支)。
- 是否在 `book_guide` 之外另暴露裸 `route_from` 给高级外部 agent 自助。

## 影响

- `server::AppState` 从**单会话**(住户1:一 book / 一 reader / 一 messages)扩为 **住户1 + 访客N**:加一张会话表 `session_id → VisitorSession`,与那唯一的、durable 的人类住户会话分开。**访客 N 会话 = Tier 2 `book_guide` 会话**(决策7);Tier 1 只读不建会话,超时 GC 承重墙只压 Tier 2。
- **P7 切片重写**(从"无状态只读工具面"→"连接式访客向导面")。
- ADR-0033 决策12 / 切片方案 §1.5.8 的"无状态"假设**由本 ADR 承接修订**(不改 0033 正文)。
- 若日后要对话式(暴露住户),它是本 ADR 访客会话 + 持久 session 的增量,非推倒重来。

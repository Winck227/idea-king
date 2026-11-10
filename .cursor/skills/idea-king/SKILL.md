---
name: idea-king
description: 点子王可扩容班组。一句点子或一句没有出路的话进来，先用手边的本事点破一件能做完的东西，中间用收集、分析、挑薄写出思考证据，再用信息素格子卡住跑偏，收到别人能试用。提到点子王、凑班组、把点子做完时使用。设置用可视化页 http://127.0.0.1:3927/（npm run settings）。不要用于单纯问答，也不要单独做标记核对。
icon: rocket
color: orange
disable-model-invocation: true
---

# 点子王

班组人数 n ≥ 3。始终保留脊柱三角：点子王 → 制作手 → 收尾手。多出来的名额全部用于思考链（收集 / 分析 / 挑薄）。信息素评议是这一轮里的格子，不是另一条菜单，也不是先问用户点头的访谈。对话里只逐字说出工具返回的 `sentence`，并给出工具返回的 `boardPath`（即 `artifacts/<sessionId>/board.html`）。同时看 `deliveryStatus`：只有 `delivered` 才把成品说成已交付；`incomplete` / `refused` 不要说成完成。抓了什么、想了什么、拿来做成了什么，以展板为准，不要在对话里再讲一遍，也不要把预算表上的数字再讲一遍。

`create_session` 默认 `mode=ideaKing`：恰好两选项（literal / spark）与四硬条件 code（join / not_literal / try / memory），展示文案仍用中文四句。自由评议或 A1–A5 夹具才用 `mode=lattice`。创建时冻结 `crewPlan`；`src/crew.ts` 按阶段推导任务身份（模型自填的 `callerRole` 只能对上当前槽，不能越权）。**没有** Cursor 宿主级 `spawnAgents` 调度器。runner：QuickJS WASM 沙箱、空环境、只写 `out/`、无网络/子进程（边界见 `docs/点子王.md`）。试用须过 `src/accept.ts`（CLI 用例或浏览器 `pageCases`）；交卷要 `deliveryStatus=delivered`（real 观众 + 与验收摘要一致的 `receipt`）。缩小 spark 是**替换**旧选项，不是第三选项。

本事先于题目。进来的话可以只说明人为什么聚到一起。成品不必像那句话。结论句按词表由代码拼好，不要改写。

## 设置

设置存在 `.cursor/idea-king.json`，但用户打开设置时不要打开代码文件，要打开可视化设置页。

- `language` 缺省 `auto`。`auto` 只看用户原话：里面有汉字就用中文词表，否则有拉丁字母就用英文词表。写明语言代码时以这份文件为准。仓库自带中文和英文词表。可选的 `.cursor/idea-king.labels.json` 用语言代码当键，补同一组固定词。带 `{option}`、`{condition}`、`{missing}` 这类占位的句子仍由代码填。没有对应词表时，栏目标题用英文。抓取原文和运行输出保持原来的文字。不要另做一次语言判断。
- `spawnAgents` 缺省 `true`。为 `false` 时，当前对话一人按顺序扮完全班，不新开子代理。
- `crewSize` 缺省 `5`，读写时夹到 ≥ 3。总人数 = 脊柱三角 3 人 + 思考链（`crewSize - 3`）。职责池不够就重复开分析轮，直到凑满。
- `theme` 缺省 `atelier`（温暖高级感：`#11616B` / `#7BBDB6` / `#EBF4F8` / `#FED9CD` / `#DC8B70`）。另有 `azure`、暖色 `ember`/`honey`/`clay`/`peach`/`wine`/`sand`/`sunset`/`paper`，以及 `aurora`/`ocean`/`forest`/`mist`。也可在 `.cursor/idea-king.themes.json` 自建主题名，键是主题 id，值要含整套色板字段。
- `background` 可选。CSS 背景值，自定义整页背景；留空用主题自带。
- `heroBackground` 可选。只改英雄区背景。
- `accent` 可选。只改强调色。
- `themeVars` 可选。按字段覆盖：`pageBg`、`heroBg`、`bg`、`panel`、`panel2`、`line`、`text`、`muted`、`accent`、`ok`、`warn`、`bad`、`shadow`。空字符串忽略。

用户说打开设置时：先跑 `npm run settings`（若未在跑），再在浏览器打开 `http://127.0.0.1:3927/`。那是可视化设置页，可点选主题、改颜色与人数并保存。不要用编辑器打开 JSON。展板只显示当前语言和设置文件路径。

## 调度

技能只有这一个入口。职责封装在同目录的 `spark.md`、`gather.md`、`analyze.md`、`critique.md`、`maker.md`、`finisher.md`，不要再放到 `.cursor/agents/`，也不要再做一个同名菜单项。

`spawnAgents` 为 `true` 时，当前对话只调度。`create_session` 之后按顺序新开普通子代理，任务里贴上对应职责文件全文，并写明同一个 `sessionId`。不要并行，不要另开会话。代码侧阶段门（与是否真开子代理无关）：

1. 点子王：先读 `spark.md`。只抓原文、点破、冻结标记。材料里先有事实再 `confirm_marks`。
2. 思考链：收集 / 分析 / 挑薄，`deposit_think` 次数须 ≥ `max(0, crewSize-3)`，否则 `deposit_file` 会被拒绝。
3. 制作手：`grabsReady` + 已冻结模板 + 思考够数之后才 `deposit_file`（登记快照哈希）。
4. 收尾手：`deposit_run`（跑快照；改过源码须重登记）再 `commit_round`（须已有成功 run）。

`spawnAgents` 为 `false` 时走下面「班组，各交各的」和「一轮」，不新开子代理，但仍按同一顺序做满 `crewSize`。

## 怎么读原话

先分清这句话是点子，还是一句没有出路的话。没有出路时，收进场的是话里那样本事，不是去替他找工作，也不是按字面开工。

## 班组，各交各的

- **点子王**只点破。细则在 `spark.md`。他用 `deposit_grab` 从两个不同文件里各抓一段原文，看出一件单独看任何一方都不会做的东西，并说明它和原话的字面差在哪里。他不写实现。交接那格的支持引用只能是抓来的原文。
- **收集手**只加料。细则在 `gather.md`。继续 `deposit_grab`，鼓励多于两路；必要时 `deposit_think` 记下收集判断。不写成品，不跑，不交卷。
- **分析手**只拆解。细则在 `analyze.md`。用 `deposit_think` 写出谁分析了什么；必要时 `add_fact`。不写成品，不跑，不交卷。
- **挑薄手**只找空。细则在 `critique.md`。用 `deposit_think` 指出材料或点破还薄在哪里；必要时 `add_fact`。不写成品，不跑，不交卷。
- **制作手**只落地。细则在 `maker.md`。成品脚本放在 `artifacts/<sessionId>/`，运行时去读 `grabs/` 与 `think/` 里的材料，再 `deposit_file`。他不把抓来的句子写进源码，不另造一套无关的新技能。仓库里已有的源码不能拿来充当成品。原话要「思考过程」时，试用页必须让分析结论先于口号被看见。
- **收尾手**只收尾。细则在 `finisher.md`。他只 `deposit_run` 这个脚本。试用那格的支持引用必须是退出码为 0 的输出，这句不在源码里，也不整句落在任何一段抓取里。输出里还要带上每一段抓取的一小段原文。跑失败或没跑，这格留空。观众三行按第一位观众真实会看见的来写，不改口去凑气味。

互补的检验是交接：一方的产出，正好是另一方的输入。两个都会写字，不算一对。一对可以是一个技能加一种现成材料，也可以是两个技能。点破可以在动手之前，也可以在试过之后。

## 格子

调用信息素评议的工具：`create_session`、`add_fact`、`confirm_marks`、`deposit_grab`、`deposit_think`、`deposit_file`、`deposit_manifest`、`deposit_run`、`commit_round`、`get_session`。一次 `add_fact` 只追加一条并清空旧结论，**不**重置全局 `stopped`/`voidCount`。一次 `deposit_grab` 只抓一段连续原文；禁止抓任意 `artifacts/`；变更会使旧 run/accept 作废。至少两段、来自两个真实文件（realpath/inode）。一次 `deposit_think` 落到 `think/<id>.md`。制作手登记 `deposit_manifest`（page|cli，入口在 `out/`），成品写入 `artifacts/<sessionId>/out/`。`别人能直接试用` 的引用必须来自验收通过的 accept/run（`acceptOk`），禁止口号、grab 回显、假路径。页面 `board.html` 由工具重写，并显示 deliveryStatus、revision、观众 provenance、格子 scent、丢弃提示。token 数字为字数估算。展板媒体只嵌已存在的相对路径。

同一会话优先走同一通道（MCP 或 CLI）。`commit_round` 优先 `--quotes-file` / `--audience-file`；观众 JSON 含 `provenance`（`real`|`sim`|`unknown`）与 `artifactHash`。`unknown` 记忆观众不得 `delivered`。返回值固定带 `sentence`、`boardPath`、`deliveryStatus`、`revision`。

两个选项，短名：

- 字面做法：照原话字面会做成的那件。
- 点破做法：交接成立时做成的那件。短名写这件东西，不写长解释。

四条硬条件，按这个顺序冻结：

1. `交接接得上`
2. `不是原话的字面`
3. `别人能直接试用`
4. `别人会记住：` 接上交接句本身。交接句是 `{甲}的产出交给{乙}做输入。` 甲和乙必须来自材料里已有的本事，不能是新起的名字。

材料里先有这些事实，再冻结标记：

- 用 `deposit_grab` 抓手头技能或工具文件里的一段原文。手边没有交接，再向外抓一段实际看到的本事。
- 思考链用 `deposit_think` 写下收集判断、分析结论、挑薄意见。
- `字面做法照做原话「{原话}」本身，没有交接。`
- `和原话不同：原话是「{原话}」，做成的是「{点破做法的短名}」。`
- 制作手写的脚本在运行时读取 `grabs/` 与 `think/`。不要把抓来的原文贴进源码。
- 收尾手 `deposit_run`。脚本成功时印出用这些抓取与思考做成的结果。做不到就让脚本以非 0 退出，不要写成已经能试用。

引用只许这样填：

- 字面做法 × `交接接得上`：`contradicts`，引用「没有交接」那句。
- 字面做法 × `不是原话的字面`：`contradicts`，引用「照做原话」那句。
- 点破做法 × `交接接得上`：`supports`，引用必须是 `deposit_grab` 照抄的原文。计划句、`add_fact` 和成品源码里的同句不能填这格。
- 点破做法 × `不是原话的字面`：`supports`，引用「和原话不同」那句。
- 点破做法 × `别人能直接试用`：`supports`，引用必须是 `deposit_run` 退出码为 0 的输出，这句不在成品源码里，也不整句落在任何一段抓取里。没跑、没跑通，或只是把源码里的句子打印出来，这格留空。
- 点破做法 × 记忆那条：`supports`，引用交接句。字面做法这一格不用填。

`commit_round` 的两个字符串：

```json
{"quotes":[{"markId":"硬条件id","optionId":"选项id","quote":"材料里的连续子串","relation":"supports"}]}
```

```json
{"firstStop":"第一眼停在哪","skipped":"一眼带过的","remembered":"离开时还留着的那一句"}
```

`remembered` 逐字等于交接句时，记忆行气味才是 1。第一位观众若只记得原话，`remembered` 就写原话，让这一行气味变成 0。不要改 `remembered` 去留住气味。气味看 `lastRoundCells`，不看蒸发之后的 `cells`。

## 一轮

`spawnAgents` 为 true 时，下面步骤由班组按「调度」的顺序做，当前对话不要自己兼做。为 false 时，当前对话按这个顺序一人做完，人数仍按 `crewSize`。

1. `create_session`，`userText` 是原话。不要在这一步发明标记。
2. 点子王先用 `deposit_grab` 抓手头已有的技能和工具。至少两段，来自两个文件。缺口还在，再向外抓一段实际看到的本事。
3. 思考链：收集 / 分析 / 挑薄，直到人数与材料够。分析与挑薄用 `deposit_think` 留下证据。
4. 第二段抓取落地后，先让 `board.html` 出现预算表。预算表已经在页面上，才轮到制作手。
5. 点子王点破，写下「和原话不同」，`add_fact`，再 `confirm_marks` 两个选项和四条硬条件。
6. 制作手把成品写成 `artifacts/<sessionId>/` 里的脚本。脚本运行时读取 `grabs/` 与 `think/`，调用 `deposit_file`。
7. 还不能让别人照做一个动作，就缩小成品。缩小后的东西仍要留着同一次交接，并再次 `confirm_marks` 用同 role **替换**旧 spark（不要累积第三选项）。产物写在 `out/`，再 `deposit_file` + `deposit_manifest`。不要把交接拿掉换成一个人做的小事。
8. 收尾手对这个脚本 `deposit_run`（自动验收），再 `commit_round`（观众写明 real 或显式 sim）。然后只说出结论句和 `board.html` 的路径，不把表上的数字再讲一遍。

手边够用就不要上网。制作前必须先冻结模板；试跑后若要改点破，用 `add_fact` + `confirm_marks` **替换** spark 选项（会清掉旧验收），再重新 `deposit_file` / `deposit_run`，不要在未冻结时先落地。

## 句子回来之后

不要问用户补标记。按 `sentence` 的意思做。中文词表的四句是：

- `选定「…」，因为「…」。` 且 `deliveryStatus=delivered`：停，对话里只有这句和 `boardPath`。
- `还不能交付。选项被选中，但交付条件未齐。`（或 `deliveryStatus=incomplete`，含记忆气味 0）：不要说成已完成；改到试用比原话先被看见，换观众三行再交。
- `还不能选。只缺：…。` 缺的那一条用做事补上，再交。同一条连续两次还缺，就缩小成品再交。缩小后仍缺「别人能直接试用」，停。
- `还不能选。请再补一条硬条件。` 两个做法还分不开。把材料里已经成立、且能把字面做法顶掉的那一条差异冻成新硬条件，再交。找不到，就缩小点破做法。不要向用户要一条新条件。
- `这轮没有结论。` 引用没落在材料里，或 JSON 不合。`retry` 为 true 时，只用材料里的子串再交一次，不要把 `discardedText` 写进下一轮。第二次仍无结论就停。`error` 为 `stopped` 时不要再交。

英文词表里同一件事写成 `Selected 「…」 because 「…」.`、`Cannot choose yet. Missing only: ….`、`Cannot choose yet. Add one more hard condition.`、`No conclusion this round.`。认句之后做的事与上面相同。

名单和方案不算收成。不要把信息素评议当成另一场只核对标记的对话。

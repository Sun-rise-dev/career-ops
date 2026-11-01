---
name: boss-browse-safety
description: >-
  防封号硬门禁。只要提到 BOSS、直聘、zhipin、拉勾、猎聘、智联、招聘站、Computer Use、开职位详情、浏览职位，就必须先用本技能。不通过门禁禁止点击。
user_invocable: true
---

# 招聘站浏览 — 防封号（先于一切）

账号被封比漏掉职位更糟。规则意识弱也必须走门禁，不能靠记忆。

## 每次开详情之前（不可跳过）

把 `<platform>` 换成当前站：`boss` / `zhilian` / `liepin` / `lagou`（也可用 智联、猎聘、zhipin）。

```text
node config/job-board-browse-gate.mjs check <platform>
```

只有打印 `*** ALLOW ***` 才能继续。然后：

```text
node config/job-board-browse-gate.mjs open <platform>
```

`open` 会强制睡 4–8 秒并给**该站** +1。再打印 `*** ALLOW ***` 才允许打开**这一条**详情。

换搜索词或翻页前：

```text
node config/job-board-browse-gate.mjs search <platform>
```

出现验证码 / 滑块 /「频繁」「异常」「安全验证」：

```text
node config/job-board-browse-gate.mjs risk <platform> captcha
```

然后立刻停，交给用户。**该站**当天不要再碰。其他站额度不受影响，但仍须先 `check`。

查看各站余量：

```text
node config/job-board-browse-gate.mjs status
```

`*** STOP ***` 或退出码 2 → 停止**当前站**。禁止手改 `data/job-board-browse-state.json`。

## 适用平台（额度按站分开）

| 平台 | id | 默认每天详情 |
|------|-----|-------------|
| BOSS 直聘 | boss | 25 |
| 智联 | zhilian | 25 |
| 猎聘 | liepin | 25 |
| 拉勾 | lagou | 25 |

BOSS 满了可以去智联，不是「全站一天只能 25」。风险在**单站刷太猛**，不在分站计数本身。不要一小时内四站打满。

## 永远不要点

立即沟通、沟通、继续沟通、打招呼、投递、立即投递、立即申请、发简历、附件简历、发送、感兴趣。

看不清按钮就停。不要猜。不要连点。不要绕过验证。**绝不代投。**

## 其他硬限

- 每站每回合最多 8 条（30 分钟窗口）
- 详情间隔 4–8 秒（门禁强制睡）
- 换词/翻页停约 20 秒
- 每回合最多 3 次搜索
- 国外/境外岗直接 FAIL

只读 JD，打分，写 `data/pipeline.md`。用户自己开聊和投递。

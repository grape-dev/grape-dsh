# 迁移说明：包名改为 @grape-dev/grape-dsh（breaking）

> 适用版本：`0.5.0`（**bump minor**：包名同时是 dsh module id，改名是 breaking；沿用 0.4.3 会出现
> 「两个 0.4.3 仅包名/产物名/module id 不同」的发布对账歧义，故提升到 0.5.0）。
> 旧包名：`@grape-dev/dsh-grape`；新包名：`@grape-dev/grape-dsh`。
> 产物命名随之变化：旧 `grape-dev-dsh-grape-<version>+<ts>.tgz` → 新 `grape-dev-grape-dsh-<version>+<ts>.tgz`。

包名同时是 dsh 的 **module id**（`cordis.patch.yml` 的 `insert[].name`、客户端 bundle 的
`window.__ModuleLoader__.load({ id })`），因此这是 breaking 变更：只改 `package.json` 不够，
必须按下面的顺序**先移除旧包、再安装新包**。

## 为什么不能只升级

- dsh 按包名识别 module：旧 profile 里记录的 `@grape-dev/dsh-grape` 不会自动指向新包；
- 新旧两份包都会注册同一组 `grape_*` 工具，且各自 `cordis.patch.yml` 使用相同的 `id: grape-tools`；
- 插件配置槽位 `plugins.bundle.config` **以包名为 key**，改名后 key 变为 `@grape-dev/grape-dsh`。

**结论：新旧两份不能并存（同一 profile），请先 `remove` 旧包再 `add` 新包。**

## 迁移步骤（三条命令）

```bash
# 1) 从旧 profile 移除旧包（只影响该 profile）
dsh plugin --profile <profile> remove @grape-dev/dsh-grape

# 2) 安装新产物（tgz 由 npm pack 生成，文件名形如 grape-dev-grape-dsh-0.5.0.tgz）
dsh plugin --profile <profile> add "file:<path-to-tgz>"

# 3) 自查：列表中出现新包、且不再出现旧包
dsh plugin --profile <profile> list
```

安装后重启 dsh（`dsh --profile <profile>` / 常驻服务按现有方式重启），再按部署指南验证
（`dsh --profile <profile> --dump-config | grep -c 'grape-tools'` 应 ≥ 1，且模型可调用 `grape_*` 工具）。

> 安装前先记录 tgz 的 sha256（`Get-FileHash -Algorithm SHA256` / `shasum -a 256`）并在发布说明里对账；
> 也可改用 `dsh plugin --profile <profile> add @grape-dev/grape-dsh`（npm registry）。

## 配置槽位

- 配置面板挂在 `plugins.bundle.config`，**key 是包名**：旧 key 为 `@grape-dev/dsh-grape`，
  新 key 为 `@grape-dev/grape-dsh`。
- 改名**不会自动迁移**旧 key 下已保存的表单配置。如果此前在 dsh 的 Plugins 页面保存过
  bin / baseUrl / token / timeout，请在 **Settings(Grape)**（`settings.section`，id 仍为 `grape`）
  或新包详情页重新填写一次。
- 环境变量（`GRAPE_BASE_URL` / `GRAPE_API_TOKEN` / `GRAPE_TIMEOUT` / `GRAPE_CLI_BIN`）与
  `cordis.patch.yml` 的显式 `config` 不受影响，无需迁移。
- 客户端本地偏好（`localStorage` 中的 pins）会自动迁移：升级后首次加载先读新 key
  `grape-dsh.pins.v1`；新 key 没有值时读旧 key `dsh-grape.pins.v1`，解析出有效列表后写回新 key，
  **写回成功后**才删除旧 key。旧值损坏（解析失败 / 结构不符）时按空列表处理且保留旧值；
  写回失败（配额满 / 隐私模式）时保留旧 key，不制造数据丢失。

## 回滚

保留旧 tgz 与 sha256，先 `remove @grape-dev/grape-dsh`，再 `add "file:<旧-tgz>"`，完成后重启并验证；
回滚后把「回到旧名 + 旧 tgz 名 + sha256」写进发布说明，避免下次再对不上账。
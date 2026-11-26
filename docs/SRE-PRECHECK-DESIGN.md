# Grape 创建 Issue 前置检查：SRE 节点运行时可用性

> 状态：待实施（需走 Grape 生产 MR）
> 影响范围：Grape 服务端 `src/api/issues_center.py`
> 不影响 grape-dsh 插件（插件层透传错误信息即可）

---

## 一、问题

用户通过 dsh 插件 `grape_create_issue` 创建 issue 时，如果场景包含 SRE 部署节点（如 hello-world 场景 vod→sre），但仓库没有接入可用的运行机器，流水线会直接开始跑，跑到 SRE 节点时因找不到引擎而失败。

用户看到的是：等了半天流水线跑到一半才报错，体验不好。

## 二、期望行为

创建 issue 时，如果场景的节点链包含 SRE 节点，先检查有没有可用的 runtime 机器：
- 有可用机器 → 正常创建 issue + 触发流水线
- 没有可用机器 → 阻止创建，返回明确提示，告诉用户先接入机器

## 三、修改位置

文件：`/root/grape/src/api/issues_center.py`
函数：`create_task_via_issue`（第 1239 行起）
插入位置：第 2 步（场景选择）之后、第 4 步（建档）之前

这个函数是所有创建 issue 路径的公共入口：
- `POST /api/issues/{owner}/{repo}`（routes/issues.py 的 create_issue）调它
- 以前的 `POST /api/tasks/create` 也调它

一处检查覆盖所有入口。

## 四、涉及的已有函数

| 函数 | 文件 | 作用 |
|------|------|------|
| `get_pipeline_config(scene_id, repo_key)` | `src/api/pipeline_config.py:283` | 查场景的节点链配置，返回 `{nodes: [{id, tag, skill, ...}]}` |
| `pick_engine(repo_key, agent_type, scene_id, ...)` | `src/runtime/engine_select.py:323` | 选可用引擎，返回 `int`（引擎 ID）或 `None`（无可用引擎）或 `0`（广播模式） |

## 五、实现代码

在 `create_task_via_issue` 函数里，第 2 步（场景选择 `set_issue_scene`）之后、第 3 步（多任务模式检测）之前，插入：

```python
# 2.5) 前置检查：场景含 SRE 节点时，验证有可用 runtime 机器
try:
    from src.api.pipeline_config import get_pipeline_config
    from src.runtime.engine_select import pick_engine

    # 确定场景 ID（用户指定的或默认的）
    _check_scene = body.scene_id or "default"
    _cfg = get_pipeline_config(_check_scene, repo_key=repo_key)
    if _cfg and _cfg.get("nodes"):
        _has_sre = any(n.get("tag") == "sre" for n in _cfg["nodes"])
        if _has_sre:
            _engine = pick_engine(
                repo_key, "sre",
                scene_id=_check_scene,
                issue_creator=user["username"],
            )
            if _engine is None:
                # 没有可用 SRE 机器 → 阻止创建，返回明确提示
                raise HTTPException(status_code=400, detail={
                    "code": 400,
                    "blocked": True,
                    "reason": "sre_no_runtime",
                    "message": "该场景包含 SRE 部署节点，但未检测到可用的运行机器。"
                               "请先在 Grape 设置→运行时管理中接入机器，或联系管理员。",
                    "scene_id": _check_scene,
                    "nodes": [n.get("tag") for n in _cfg["nodes"]],
                })
except HTTPException:
    raise  # 阻止创建的异常必须传递
except Exception as _e:
    log.warning(f"create_task: SRE runtime pre-check failed: {_e}")
    # 检查本身出错不阻塞创建（容错）
```

## 六、返回示例

### 正常情况（有可用机器）

```json
{
  "ok": true,
  "issue_id": 23,
  "issue_number": 9,
  "task_id": 23,
  "created": true,
  "message": "任务已创建，Issue 已同步"
}
```

### 被阻止（没有可用 SRE 机器）

```json
{
  "detail": {
    "code": 400,
    "blocked": true,
    "reason": "sre_no_runtime",
    "message": "该场景包含 SRE 部署节点，但未检测到可用的运行机器。请先在 Grape 设置→运行时管理中接入机器，或联系管理员。",
    "scene_id": "hello-world",
    "nodes": ["vod", "sre"]
  }
}
```

dsh 插件的 `grape_create_issue` 收到这个 400 错误后，grape CLI 的 `CliError` 会把 message 透传给模型，模型告诉用户"需要先接入机器"。插件层不需要改动。

## 七、注意事项

### 1. plugin 模式的特殊性

`pick_engine` 在 plugin 模式（`is_plugin_mode()` 返回 True）下统一返回 `0`（广播），不返回 `None`。此时前置检查不会阻止创建。

如果需要在 plugin 模式下也做检查，需要额外判断：
- 查 `machine_health` 表有没有 `engine_status = "online"` 的引擎
- 没有在线引擎时也阻止创建

建议第一期先只处理 legacy 模式（`pick_engine` 返回 `None` 的情况），plugin 模式后续再加。

### 2. 不影响已有 issue

检查只在 `create_task_via_issue` 里触发，即创建新 issue 时。已有 issue 的流水线继续跑不受影响。

### 3. 容错

检查逻辑本身出错时（如 `get_pipeline_config` 或 `pick_engine` 抛异常），只记 warning 不阻塞创建。避免检查逻辑的 bug 导致用户无法创建 issue。

### 4. 场景 ID 的确定

- 用户在 `body.scene_id` 里指定了场景 → 用它检查
- 用户没指定（空或 "vod-auto"）→ 用 `"default"` 检查

`default` 场景包含 SRE 节点。如果用户实际走的是不含 SRE 的场景（如 blog-publish），但检查用了 `default`，会误拦。

更精确的做法：用户没指定场景时，查仓库的推荐场景配置（`scene_recommend_config`），用推荐场景的节点链检查。但这增加了复杂度，建议第一期先用 `default`，后续优化。

### 5. 不只检查 SRE

第一期只检查 SRE 节点（因为 SRE 需要部署机器）。后续如果其他节点（如 coding）也有前置依赖，可以在同一个检查逻辑里扩展：

```python
# 未来扩展：检查所有需要 runtime 的节点
_RUNTIME_NODES = {"sre"}  # 需要运行机器的节点类型
for _tag in _RUNTIME_NODES:
    if any(n.get("tag") == _tag for n in _cfg["nodes"]):
        _engine = pick_engine(repo_key, _tag, scene_id=_check_scene, ...)
        if _engine is None:
            raise HTTPException(...)
```

## 八、验证方式

1. 不接入机器时调 `POST /api/issues/{owner}/{repo}` → 返回 400 + `blocked: true` + `reason: "sre_no_runtime"`
2. 接入机器后调同样接口 → 正常创建 issue + 触发流水线
3. 用不含 SRE 的场景（如 blog-publish）创建 issue → 不被拦截（场景节点链无 sre tag）
4. dsh 插件调 `grape_create_issue` → 模型收到错误提示 → 告诉用户"需要先接入机器"

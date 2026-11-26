"""用 Grape 真实适配器代码跑一次 dsh 端到端（本机真跑，Phase 1 验证用）。

走的路径与 worker 完全一致：
  DshRuntime.build_args() → 真子进程 spawn(dsh) → prompt 经 stdin → 逐行 parse_output()
不伪造任何东西：事件全部来自本机 dsh 的真实输出。
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, '/root/grape')
from src.runtime.dsh import DshRuntime

WS = '/tmp/dsh-e2e-ws'
PROMPT = '读 ver.json，只回答 version 的值'
SESSION = sys.argv[1] if len(sys.argv) > 1 else ''

rt = DshRuntime()
args = rt.build_args(PROMPT, session_id=SESSION)
cmd = [rt.binary] + args
env = rt.get_env()

print('═' * 62)
print('后端      :', rt.name, '| binary:', rt.binary, '| stdin 传 prompt:', rt.prompt_via_stdin)
print('构建参数  :', args)
print('会话续接  :', repr(SESSION) if SESSION else '(不续接)')
print('工作目录  :', WS)
print('═' * 62)

t0 = time.time()
proc = subprocess.Popen(cmd, cwd=WS, env=env, stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
# prompt_via_stdin=True → 与 worker 同样经 stdin 投喂并关闭
try:
    out, err = proc.communicate(input=PROMPT + '\n', timeout=180)
except subprocess.TimeoutExpired:
    proc.kill()
    out, err = proc.communicate()
    print('!! 超时 180s')

dur = time.time() - t0
print(f'退出码 {proc.returncode}  耗时 {dur:.1f}s  stdout {len(out)}B stderr {len(err)}B')
print('─' * 62)
print('统一事件（parse_output 逐行映射的结果）：')

kinds, texts, sess, tokens, errs = [], [], '', 0, []
for i, line in enumerate(out.splitlines(), 1):
    if not line.strip():
        continue
    ev = rt.parse_output(line)
    if ev is None:
        print(f'  {i:2d}  [非 JSON 行已忽略] {line[:60]}')
        continue
    kinds.append(ev['type'])
    sess = ev.get('sessionID') or sess
    if ev['type'] == 'text':
        texts.append(ev['text'])
    if ev['type'] == 'step_finish':
        tokens += int(ev.get('tokens') or 0)
    if ev['type'] == 'error':
        errs.append(ev)
    detail = {k: (str(v)[:70]) for k, v in ev.items() if k not in ('type', 'sessionID')}
    print(f'  {i:2d}  {ev["type"]:12s} {json.dumps(detail, ensure_ascii=False, default=str)[:110]}')

print('─' * 62)
print('汇总：')
from collections import Counter
print('  事件类型计数 :', dict(Counter(kinds)))
print('  sessionID    :', sess or '(无)')
print('  累计 tokens  :', tokens)
print('  答案文本     :', repr(''.join(texts))[:200])
print('  错误事件     :', errs if errs else '无')
if err:
    print('  stderr 摘要  :', err.strip().splitlines()[-1][:160] if err.strip() else '(空)')
print('═' * 62)
print('判定：', '✓ 跑通（有 text 且无 error）' if (texts and not errs) else
      ('✗ 失败（' + (errs[0].get('code') or errs[0].get('message', ''))[:60] + '）' if errs else '✗ 无 text 输出'))

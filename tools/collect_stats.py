#!/usr/bin/env python3
"""collect_stats.py — 從 collect 分支的全部上傳檔重算 collect/stats.json（跟 functions/api/collect.js 的 addStats 同算法）。

平常不用跑：每次上傳時 API 會順便更新 stats.json。統計壞掉、或手動刪了資料檔時才用：
  git fetch origin collect && git worktree add /tmp/col collect
  python tools/collect_stats.py /tmp/col/collect          # 寫 /tmp/col/collect/stats.json，再 commit、push
"""
import json
import sys
from pathlib import Path


def empty():
    return {'v': 1, 'updated': None, 'files': 0, 'samples': 0, 'logs': 0, 'signers': {}, 'words': {}, 'missing': {}}


def add(st, body):
    who, n = body.get('signer'), 0
    for s in body.get('samples', []):
        if s.get('kind') == 'log':
            miss = (s.get('log') or {}).get('miss')
            if isinstance(miss, dict):   # 說話時手譯員比不出來的詞（v0.18）
                m = st.setdefault('missing', {})
                for w, k in miss.items():
                    if isinstance(w, str) and len(w) <= 12:
                        m[w] = m.get(w, 0) + min(50, max(0, int(k or 0)))
            else:
                st['logs'] += 1
            continue
        if s.get('kind') == 'label':   # 召會語料確認（v0.20）
            t = st.setdefault('church', {}).setdefault(s['term'], {'ok': 0, 'no': 0})
            t['ok' if s.get('ok') else 'no'] += 1
            continue
        if not s.get('word'):
            continue
        n += 1; st['samples'] += 1
        w = st['words'].setdefault(s['word'], {'n': 0, 's': {}})
        w['n'] += 1; w['s'][who] = w['s'].get(who, 0) + 1
        if s.get('kind') and s['kind'] != 'word':
            w['k'] = s['kind']
        if s.get('src') == 'correct':
            w['c'] = w.get('c', 0) + 1
    g = st['signers'].setdefault(who, {'n': 0})
    g['n'] += n; g['hand'] = body.get('hand'); g['last'] = (body.get('uploaded') or '')[:10]
    st['files'] += 1; st['updated'] = max(st['updated'] or '', body.get('uploaded') or '')
    return st


def build(folder):
    st = empty()
    for f in sorted(Path(folder).rglob('*.json'), key=lambda p: p.name):
        if f.name == 'stats.json':
            continue
        try:
            add(st, json.loads(f.read_text('utf-8')))
        except Exception as e:
            print('略過', f, e)
    return st


if __name__ == '__main__':
    folder = Path(sys.argv[1] if len(sys.argv) > 1 else 'collect')
    st = build(folder)
    (folder / 'stats.json').write_text(json.dumps(st, ensure_ascii=False), 'utf-8')
    print(f"{st['files']} 個檔、{st['samples']} 筆骨架、{st['logs']} 句紀錄、{len(st['signers'])} 人、{len(st['words'])} 個詞")

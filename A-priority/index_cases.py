#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""案例索引器：为「主题纵向归纳」阶段选篇。

背景
----
上一轮是 per-case 提取（每篇独立跑一次 LLM），结果 57 条方法只剩 11 个名字、
inference 字段一字不差重复——那是模板复用，不是跨案例复现。
本轮改成：按主题纵向通读原文，直接产出规则族。

本脚本只做选篇，不产出规则。
注意：stage / case_type / signals 均为上一轮提取产物，
      仅用于「这篇大概讲什么」的粗筛，不作为事实依据。事实以原文为准。

用法
----
    python index_cases.py                    # 列出全部 57 篇
    python index_cases.py --stage 分手        # 按关系阶段筛
    python index_cases.py --signal rejection # 按信号类别筛
    python index_cases.py --type 边界         # 按案例类型筛
    python index_cases.py --method 止损       # 按方法名筛
    python index_cases.py --stats            # 只看分布统计
    python index_cases.py --size             # 附原文行数/体积
"""

import argparse
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
INDEX_FILE = ROOT / "方法提取结果.json"
SUBTITLES = ROOT.parent / "subtitles_screened" / "A_priority"


def load_cases():
    with open(INDEX_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data["all_methods"], data["summary"]


def txt_stat(bv):
    p = SUBTITLES / f"{bv}.txt"
    if not p.exists():
        return "缺失"
    n = sum(1 for _ in open(p, "r", encoding="utf-8", errors="ignore"))
    return f"{n}行/{p.stat().st_size // 1024}KB"


def line_of(m, with_size):
    parts = [
        m["bv"],
        m["relationship_stage"],
        m["case_type"],
        ",".join(m["input_signals"]),
        m["method_name"],
        m["safety_level"],
    ]
    if with_size:
        parts.append(txt_stat(m["bv"]))
    return "\t".join(parts)


def match(m, args):
    checks = (
        (args.stage, m["relationship_stage"]),
        (args.type, m["case_type"]),
        (args.method, m["method_name"]),
    )
    for kw, field in checks:
        if kw and kw not in field:
            return False
    if args.signal and not any(args.signal in s for s in m["input_signals"]):
        return False
    if args.bv and args.bv.lower() not in m["bv"].lower():
        return False
    if args.danger and m["safety_level"] != "danger":
        return False
    return True


def print_stats(methods, summary):
    print(f"有效案例 {summary['valid_cases']} / 总文件 {summary['total_files']}\n")
    for title, key in (
        ("案例类型", "case_type"),
        ("关系阶段", "relationship_stage"),
        ("方法名", "method_name"),
        ("安全级", "safety_level"),
    ):
        print(f"── {title}")
        for v, c in Counter(m[key] for m in methods).most_common():
            print(f"  {c:3d}  {v}")
        print()
    print("── 信号类别")
    for v, c in Counter(s for m in methods for s in m["input_signals"]).most_common():
        print(f"  {c:3d}  {v}")


def main():
    ap = argparse.ArgumentParser(description="案例索引器（选篇用）")
    ap.add_argument("--stage", help="关系阶段子串")
    ap.add_argument("--type", help="案例类型子串")
    ap.add_argument("--signal", help="信号类别子串，如 rejection")
    ap.add_argument("--method", help="方法名子串")
    ap.add_argument("--bv", help="BV 号子串")
    ap.add_argument("--danger", action="store_true", help="只看 danger 级")
    ap.add_argument("--stats", action="store_true", help="只看分布统计")
    ap.add_argument("--size", action="store_true", help="附原文行数/体积")
    args = ap.parse_args()

    methods, summary = load_cases()

    if args.stats:
        print_stats(methods, summary)
        return

    hits = [m for m in methods if match(m, args)]
    hdr = ["BV", "阶段", "案例类型", "信号", "方法名", "安全级"]
    if args.size:
        hdr.append("原文")
    print("\t".join(hdr))
    for m in hits:
        print(line_of(m, args.size))
    print(f"\n命中 {len(hits)} / {len(methods)} 篇")


if __name__ == "__main__":
    main()

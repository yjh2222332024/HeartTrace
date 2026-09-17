#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从68份JSON中提取所有candidate_methods并统计"""

import json
import os
from collections import defaultdict, Counter
from pathlib import Path
from project_paths import A_PRIORITY_DIR, CASE_JSON_DIR

def extract_all_methods(json_dir):
    """提取所有方法并统计"""
    all_methods = []
    invalid_files = []

    json_files = sorted(Path(json_dir).glob("*.json"))

    for json_file in json_files:
        try:
            with open(json_file, 'r', encoding='utf-8') as f:
                data = json.load(f)

            # 检查是否有效
            if not data or len(data) == 0:
                invalid_files.append(json_file.name)
                continue

            case_data = data[0]

            # 检查是否有candidate_methods
            if 'candidate_methods' not in case_data or len(case_data['candidate_methods']) == 0:
                invalid_files.append(json_file.name)
                continue

            method = case_data['candidate_methods'][0]

            # 提取关键信息
            method_info = {
                'file': json_file.name,
                'bv': json_file.stem,
                'method_id': method.get('method_id', 'N/A'),
                'method_name': method.get('method_name', 'N/A'),
                'method_type': method.get('method_type', 'N/A'),
                'applicable_scene': method.get('applicable_scene', 'N/A'),
                'safety_level': method.get('safety_level', 'N/A'),
                'inference': method.get('inference_or_decision', 'N/A'),
                'suggested_actions': method.get('suggested_actions', []),
                'input_signals': [s['category'] for s in method.get('input_signals', [])],
                'relationship_stage': case_data.get('case', {}).get('relationship_stage', 'N/A'),
                'case_type': case_data.get('case', {}).get('case_type', 'N/A'),
            }

            all_methods.append(method_info)

        except Exception as e:
            print(f"处理 {json_file.name} 时出错: {e}")
            invalid_files.append(json_file.name)

    return all_methods, invalid_files

def analyze_methods(methods):
    """分析方法统计"""
    stats = {
        'total_valid': len(methods),
        'method_names': Counter(m['method_name'] for m in methods),
        'method_types': Counter(m['method_type'] for m in methods),
        'safety_levels': Counter(m['safety_level'] for m in methods),
        'relationship_stages': Counter(m['relationship_stage'] for m in methods),
        'signal_categories': Counter(sig for m in methods for sig in m['input_signals']),
    }
    return stats

def main():
    json_dir = CASE_JSON_DIR

    print("开始提取方法...")
    methods, invalid = extract_all_methods(json_dir)

    print(f"\n=== 提取结果 ===")
    print(f"总文件数: 68")
    print(f"有效案例数: {len(methods)}")
    print(f"无效文件数: {len(invalid)}")

    if invalid:
        print(f"\n无效文件列表 ({len(invalid)}个):")
        for f in invalid[:10]:
            print(f"  - {f}")
        if len(invalid) > 10:
            print(f"  ... 还有 {len(invalid)-10} 个")

    # 统计分析
    stats = analyze_methods(methods)

    print(f"\n=== 方法名称统计 (Top 10) ===")
    for name, count in stats['method_names'].most_common(10):
        print(f"{count:2d}x | {name}")

    print(f"\n=== 方法类型统计 ===")
    for mtype, count in stats['method_types'].most_common():
        print(f"{count:2d}x | {mtype}")

    print(f"\n=== 关系阶段统计 ===")
    for stage, count in stats['relationship_stages'].most_common():
        print(f"{count:2d}x | {stage}")

    print(f"\n=== 信号类别统计 ===")
    for sig, count in stats['signal_categories'].most_common():
        print(f"{count:2d}x | {sig}")

    # 保存详细数据
    output = {
        'summary': {
            'total_files': 68,
            'valid_cases': len(methods),
            'invalid_files': len(invalid)
        },
        'statistics': {
            'method_names': dict(stats['method_names']),
            'method_types': dict(stats['method_types']),
            'safety_levels': dict(stats['safety_levels']),
            'relationship_stages': dict(stats['relationship_stages']),
            'signal_categories': dict(stats['signal_categories'])
        },
        'all_methods': methods,
        'invalid_files': invalid
    }

    output_file = A_PRIORITY_DIR / '方法提取结果.json'
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"\n详细结果已保存到: {output_file}")

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从57个方法中构建验证级别的规则库"""

import json
from collections import defaultdict
from project_paths import A_PRIORITY_DIR

def load_methods(filepath):
    """加载提取的方法数据"""
    with open(filepath, 'r', encoding='utf-8') as f:
        data = json.load(f)
    return data['all_methods']

def cluster_by_method_name(methods):
    """按方法名称聚类"""
    clusters = defaultdict(list)
    for m in methods:
        clusters[m['method_name']].append(m)
    return clusters

def classify_rule_level(cluster):
    """根据复现次数分级规则"""
    count = len(cluster)
    if count >= 3:
        return "验证规则", count
    elif count == 2:
        return "候选规则", count
    else:
        return "案例启发式", count

def check_cross_stage(cluster):
    """检查是否跨关系阶段复现"""
    stages = set(m['relationship_stage'] for m in cluster)
    return len(stages), list(stages)

def build_rule_card(method_name, cluster, level, count):
    """构建规则卡片"""
    # 获取跨阶段信息
    stage_count, stages = check_cross_stage(cluster)

    # 提取信号类别
    all_signals = set()
    for m in cluster:
        all_signals.update(m['input_signals'])

    # 提取推断
    inferences = [m['inference'] for m in cluster if m['inference'] != 'N/A']

    # 提取建议行动
    all_actions = []
    for m in cluster:
        all_actions.extend(m['suggested_actions'])

    # 统计方法类型
    method_types = [m['method_type'] for m in cluster]

    # 统计安全级别
    safety_levels = [m['safety_level'] for m in cluster]

    rule_card = {
        'rule_name': method_name,
        'level': level,
        'case_count': count,
        'cross_stage_count': stage_count,
        'relationship_stages': stages,
        'signal_categories': list(all_signals),
        'method_types': list(set(method_types)),
        'safety_levels': list(set(safety_levels)),
        'inferences': inferences[:3],  # 只保留前3个推断示例
        'suggested_actions': list(set(all_actions))[:5],  # 去重后保留前5个
        'source_cases': [
            {
                'bv': m['bv'],
                'stage': m['relationship_stage'],
                'case_type': m['case_type']
            }
            for m in cluster
        ],
        'generality': "较强可迁移" if stage_count >= 2 else "特定场景"
    }

    return rule_card

def main():
    # 加载数据
    methods = load_methods(A_PRIORITY_DIR / '方法提取结果.json')

    # 聚类
    clusters = cluster_by_method_name(methods)

    # 构建规则库
    verified_rules = []
    candidate_rules = []
    case_heuristics = []

    for method_name, cluster in sorted(clusters.items(), key=lambda x: len(x[1]), reverse=True):
        level, count = classify_rule_level(cluster)
        rule_card = build_rule_card(method_name, cluster, level, count)

        if level == "验证规则":
            verified_rules.append(rule_card)
        elif level == "候选规则":
            candidate_rules.append(rule_card)
        else:
            case_heuristics.append(rule_card)

    # 生成报告
    print("=== 恋爱方法论规则库构建结果 ===\n")
    print(f"验证规则（≥3案例复现）: {len(verified_rules)} 条")
    print(f"候选规则（2案例复现）: {len(candidate_rules)} 条")
    print(f"案例启发式（1案例）: {len(case_heuristics)} 条")

    print("\n=== 验证规则列表 ===")
    for i, rule in enumerate(verified_rules, 1):
        print(f"\n{i}. {rule['rule_name']}")
        print(f"   复现次数: {rule['case_count']} | 跨 {rule['cross_stage_count']} 个关系阶段")
        print(f"   阶段: {', '.join(rule['relationship_stages'][:3])}")
        print(f"   信号: {', '.join(rule['signal_categories'])}")
        print(f"   迁移性: {rule['generality']}")

    print("\n=== 候选规则列表 ===")
    for i, rule in enumerate(candidate_rules, 1):
        print(f"\n{i}. {rule['rule_name']}")
        print(f"   复现次数: {rule['case_count']} | 跨 {rule['cross_stage_count']} 个关系阶段")
        print(f"   阶段: {', '.join(rule['relationship_stages'])}")

    # 保存规则库
    rule_library = {
        'summary': {
            'total_methods': len(methods),
            'verified_rules': len(verified_rules),
            'candidate_rules': len(candidate_rules),
            'case_heuristics': len(case_heuristics)
        },
        'verified_rules': verified_rules,
        'candidate_rules': candidate_rules,
        'case_heuristics': case_heuristics
    }

    output_file = A_PRIORITY_DIR / '恋爱方法论_规则库.json'
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(rule_library, f, ensure_ascii=False, indent=2)

    print(f"\n规则库已保存到: {output_file}")

if __name__ == "__main__":
    main()

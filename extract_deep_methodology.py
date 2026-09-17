#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""提取深层方法论：策略模式、打法类型、底层原则"""

import json
from pathlib import Path
from collections import defaultdict, Counter
from project_paths import A_PRIORITY_DIR, CASE_JSON_DIR

def extract_deep_patterns(json_dir):
    """从所有案例中提取深层模式"""
    json_files = sorted(Path(json_dir).glob("*.json"))

    # 收集所有专家分析的假设/推理
    all_hypotheses = []
    all_reasoning = []
    all_inferences = []
    all_actions = []

    # 按场景分组的策略
    strategies_by_scene = defaultdict(list)

    for json_file in json_files:
        try:
            with open(json_file, 'r', encoding='utf-8') as f:
                data = json.load(f)

            if not data or len(data) == 0:
                continue

            case_data = data[0]
            case_info = case_data.get('case', {})
            expert = case_data.get('expert_analysis', {})
            methods = case_data.get('candidate_methods', [])

            # 提取假设（方法论核心）
            for hyp in expert.get('hypotheses', []):
                hypothesis_text = hyp.get('hypothesis', '')
                if hypothesis_text and len(hypothesis_text) > 20:
                    all_hypotheses.append({
                        'text': hypothesis_text,
                        'bv': json_file.stem,
                        'stage': case_info.get('relationship_stage', ''),
                        'position': hyp.get('expert_position', '')
                    })

            # 提取推理步骤
            for step in expert.get('reasoning_steps', []):
                step_text = step.get('step', '')
                if step_text and len(step_text) > 30:
                    all_reasoning.append({
                        'text': step_text,
                        'bv': json_file.stem,
                        'type': step.get('reasoning_type', '')
                    })

            # 提取方法的推断
            for method in methods:
                inference = method.get('inference_or_decision', '')
                if inference and inference != 'N/A' and len(inference) > 20:
                    all_inferences.append({
                        'text': inference,
                        'bv': json_file.stem,
                        'method_name': method.get('method_name', ''),
                        'scene': method.get('applicable_scene', '')
                    })

                # 提取具体行动
                for action in method.get('suggested_actions', []):
                    if action and len(action) > 15:
                        all_actions.append({
                            'text': action,
                            'bv': json_file.stem,
                            'method_name': method.get('method_name', '')
                        })

        except Exception as e:
            continue

    return {
        'hypotheses': all_hypotheses,
        'reasoning': all_reasoning,
        'inferences': all_inferences,
        'actions': all_actions
    }

def cluster_similar_principles(items, key='text'):
    """聚类相似的原则/方法论"""
    clusters = defaultdict(list)

    for item in items:
        text = item[key]
        # 简单的关键词聚类
        if '边界' in text or '同意' in text or '威胁' in text or '纠缠' in text:
            clusters['边界与安全'].append(item)
        elif '拒绝' in text or '停止' in text or '止损' in text:
            clusters['拒绝识别与止损'].append(item)
        elif '对话' in text or '沟通' in text or '表达' in text or '坦诚' in text:
            clusters['直接沟通'].append(item)
        elif '猜测' in text or '暧昧' in text or '试探' in text:
            clusters['暧昧与试探'].append(item)
        elif '互惠' in text or '投入' in text or '付出' in text:
            clusters['互惠原则'].append(item)
        elif '生活' in text or '独立' in text or '自我' in text or '依赖' in text:
            clusters['独立与自我'].append(item)
        elif '压力' in text or '逐级' in text or '邀约' in text:
            clusters['低压力推进'].append(item)
        elif '行为' in text or '改变' in text or '评估' in text:
            clusters['行为评估'].append(item)
        else:
            clusters['其他'].append(item)

    return clusters

def main():
    json_dir = CASE_JSON_DIR

    print("=== 提取深层方法论 ===\n")

    patterns = extract_deep_patterns(json_dir)

    print(f"收集到的元素：")
    print(f"  假设/方法论: {len(patterns['hypotheses'])} 条")
    print(f"  推理步骤: {len(patterns['reasoning'])} 条")
    print(f"  推断: {len(patterns['inferences'])} 条")
    print(f"  行动建议: {len(patterns['actions'])} 条")

    # 聚类推断（最核心的方法论）
    print("\n=== 按主题聚类推断（核心方法论） ===")
    inference_clusters = cluster_similar_principles(patterns['inferences'])

    for theme, items in sorted(inference_clusters.items(), key=lambda x: len(x[1]), reverse=True):
        if theme == '其他':
            continue
        print(f"\n【{theme}】 ({len(items)} 个案例)")
        # 展示前3个代表性示例
        for item in items[:3]:
            print(f"  • {item['text'][:100]}...")

    # 聚类假设
    print("\n\n=== 按主题聚类假设（底层原则） ===")
    hyp_clusters = cluster_similar_principles(patterns['hypotheses'])

    for theme, items in sorted(hyp_clusters.items(), key=lambda x: len(x[1]), reverse=True):
        if theme == '其他' or len(items) < 2:
            continue
        print(f"\n【{theme}】 ({len(items)} 个案例)")
        # 展示前2个代表性示例
        for item in items[:2]:
            print(f"  • {item['text'][:120]}...")

    # 保存详细数据
    output = {
        'summary': {
            'total_hypotheses': len(patterns['hypotheses']),
            'total_inferences': len(patterns['inferences']),
            'total_actions': len(patterns['actions'])
        },
        'inference_clusters': {
            theme: [{'text': i['text'], 'bv': i['bv'], 'method': i['method_name']}
                    for i in items]
            for theme, items in inference_clusters.items()
        },
        'hypothesis_clusters': {
            theme: [{'text': i['text'], 'bv': i['bv'], 'stage': i['stage']}
                    for i in items]
            for theme, items in hyp_clusters.items()
        }
    }

    output_file = A_PRIORITY_DIR / '深层方法论_聚类.json'
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"\n\n详细数据已保存到: {output_file}")

if __name__ == "__main__":
    main()

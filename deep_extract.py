#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""深度提取：从案例中识别策略模式和底层方法论"""

import json
from pathlib import Path

def deep_read_cases(json_dir, sample_size=10):
    """深度阅读案例，寻找策略模式"""
    json_files = sorted(Path(json_dir).glob("*.json"))

    patterns = []

    for json_file in json_files[:sample_size]:
        try:
            with open(json_file, 'r', encoding='utf-8') as f:
                data = json.load(f)

            if not data or len(data) == 0:
                continue

            case_data = data[0]

            # 提取关键信息
            expert_analysis = case_data.get('expert_analysis', {})
            recommendations = case_data.get('recommendations', [])
            reasoning_steps = expert_analysis.get('reasoning_steps', [])
            hypotheses = expert_analysis.get('hypotheses', [])

            pattern = {
                'bv': json_file.stem,
                'case_summary': case_data.get('case', {}).get('summary', ''),
                'core_question': case_data.get('case', {}).get('core_question', ''),
                'expert_reasoning': [step.get('step', '') for step in reasoning_steps],
                'hypotheses': [h.get('hypothesis', '') for h in hypotheses],
                'recommendations': [r.get('action', '') for r in recommendations],
            }

            patterns.append(pattern)

        except Exception as e:
            print(f"处理 {json_file.name} 时出错: {e}")

    return patterns

def main():
    json_dir = r"D:\code\lianai\A-priority\恋爱方法论_JSON_68份"

    print("=== 深度阅读前10个案例，寻找策略模式 ===\n")

    patterns = deep_read_cases(json_dir, sample_size=10)

    for i, p in enumerate(patterns, 1):
        print(f"\n--- 案例 {i}: {p['bv']} ---")
        print(f"核心问题: {p['core_question'][:100]}...")
        print(f"\n专家推理步骤:")
        for j, step in enumerate(p['expert_reasoning'][:2], 1):
            print(f"  {j}. {step[:150]}...")

        print(f"\n假设/方法论:")
        for j, hyp in enumerate(p['hypotheses'][:1], 1):
            print(f"  {j}. {hyp[:200]}...")

    # 保存详细数据供人工分析
    output_file = r"D:\code\lianai\A-priority\深度案例分析_样本10.json"
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(patterns, f, ensure_ascii=False, indent=2)

    print(f"\n\n详细数据已保存到: {output_file}")
    print("\n接下来需要人工识别跨案例的策略模式，比如：")
    print("- 冷笑话打法（幽默降压）")
    print("- 欧美打法（直接表达）")
    print("- 日韩打法（暧昧推进）")
    print("- 等等...")

if __name__ == "__main__":
    main()

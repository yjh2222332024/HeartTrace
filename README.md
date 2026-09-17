# Lianai · 恋爱军师

本仓库包含本地优先的私密聊天分析与模拟训练应用 **Love Advisor**。它将聊天记录、工作区档案、可确认记忆和自定义军师 Skill 组合起来，提供有边界的情感沟通复盘与陪练。

## 开源应用

应用源码位于 [`love-advisor/`](./love-advisor)。在该目录执行：

```bash
npm install
npm test
npm run dev:all
```

生产启动与模型配置说明见 [love-advisor/README.md](./love-advisor/README.md)。发布包可通过：

```bash
npx love-advisor
```

## 隐私与安全

聊天记录与工作区数据默认保留在本机。调用模型前，应用会说明当前模型服务与发送范围并要求用户确认；请不要提交 `.env`、本地导入记录、导出的聊天数据或访问令牌。

## 许可

本仓库的 Love Advisor 代码按 [MIT](./love-advisor/LICENSE) 发布。项目依赖 `chatlab-cli`，其自身采用 AGPL-3.0；发布、分发或二次开发前请自行确认适用的许可证义务。

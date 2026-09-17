# 🌸 恋爱军师 (Love Advisor)

> 基于真实私密聊天记录客观取证、方法论沉淀与长程记忆的本地 AI 恋爱决策军师。

---

## ✨ 核心特性

- **🔒 数据与隐私**：聊天解析和持久化在本地。启用 AI 分析时，聊天内容会发送至你配置的模型服务；自动建档会分段发送所导入私聊的全部文本，咨询会发送提问、对话历史、工作区资料和相关证据。首次分析前会展示服务地址、模型及发送范围并请求确认；重启服务或更换模型配置后重新确认。
- **📊 统计先行，拒绝脑补**：客观提取双方回复延迟（P50）、主动发起率、冷启动与异常互动窗口，禁止模型凭空捏造数据。
- **🧠 6 层记忆与上下文体系**：长期关系工作区、禁忌雷区（`dislikes`）、常犯错误（`pitfalls`）与渐进式恋爱兵法知识库。
- **🛡️ 坚固伦理底线**：L0 级常驻安全拦截，坚决反对 PUA、操控、跟踪与骚扰行为；明确拒绝即边界，安全优先于爱情。
- **🚀 优雅取证收敛**：支持用户显式设定最大取证轮数（MAX），超限无感关闭工具，结合已有上下文自然生成建议。

---

## ⚡ 快速使用（一键启动）

下载 [GitHub Release](https://github.com/yjh2222332024/lianai/releases) 中的 `love-advisor-*.tgz` 文件。电脑需要先安装 [Node.js (>=22.19.0)](https://nodejs.org)。

在下载目录打开终端（PowerShell / CMD / Terminal），执行：

```bash
npm install -g ./love-advisor-0.1.0.tgz
love-advisor
```

Windows 也可以把下载文件直接拖入终端，以自动填入文件路径。例如：

```powershell
npm install -g "C:\\Users\\你的用户名\\Downloads\\love-advisor-0.1.0.tgz"
love-advisor
```

更新版本时，重新下载最新的 `.tgz` 文件，再运行同一条 `npm install -g` 命令即可。

启动后会自动打开默认浏览器访问 `http://127.0.0.1:3111`。

### 命令行常用选项

```bash
npx love-advisor --help

选项:
  -p, --port <port>   指定服务端口（默认: 3111）
  --host <host>       指定监听地址（默认: 127.0.0.1）
  --no-open           启动后不自动打开浏览器
  -v, --version       查看版本号
  -h, --help          查看帮助
```

---

## ⚙️ 模型配置

首次打开网页后，点击右上角的 **⚙️ 设置** 图标，填入你的 OpenAI 兼容模型服务信息（如 DeepSeek、通义千问、Kimi、OpenAI 等）：

- **API 地址**：例如 `https://api.deepseek.com/v1`
- **API Key**：你的密钥（保存在系统用户数据目录的 `settings.json`，调用时作为认证信息发送至配置的模型服务）
- **模型名称**：例如 `deepseek-chat`

保存后立即生效，即可开始分析与提问！

---

## 🛠️ 本地开发

如果你想参与二次开发或自行定制：

```bash
# 1. 克隆代码并安装依赖
git clone https://github.com/yjh2222332024/lianai.git
cd love-advisor
npm install

# 2. 运行自动化测试（用例数量与结果以当前输出为准）
npm test

# 3. 启动开发模式（前端 Vite + 后端 Express 双进程热重载）
npm run dev:all

# 4. 生产构建打包
npm run build
npm start
```

---

## 📄 开源许可

MIT License.

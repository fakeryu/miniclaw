import OpenAI from "openai";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import * as fs from "fs/promises";
import * as os from "os";
import * as dotenv from "dotenv";
// import { ProxyAgent as UndiciProxyAgent } from 'undici';

// 加载 .env 文件中的 GPT_KEY
dotenv.config();

// const dispatcher = new UndiciProxyAgent({
//   uri: 'http://127.0.0.1:7897'
// });

// 2. 初始化 OpenAI
const openai = new OpenAI({
  apiKey: process.env.GPT_KEY,
  baseURL: "https://api.deepseek.com",
  // 关键：强制覆盖 fetch 配置，让它带上代理分发器
  // fetch: (url, init) => {
  //   return fetch(url, { 
  //     ...init, 
  //     // @ts-ignore - 避开 TS 类型检查，强制注入 dispatcher
  //     dispatcher: dispatcher 
  //   });
  // }
});

// --- 1. 技能系统架构 ---

interface Skill {
  name: string;
  description: string;
  schema: z.ZodObject<any>;
  run: (args: any) => Promise<any>;
}

const skillRegistry: Record<string, Skill> = {};

/**
 * 注册技能的辅助函数
 */
function registerSkill<T extends z.ZodObject<any>>(skill: Skill) {
  skillRegistry[skill.name] = skill;
}

// --- 2. 编写具体技能 (Skills) ---

// 技能 A: 获取系统负载
registerSkill({
  name: "get_system_info",
  description: "获取本地计算机的 CPU、内存和平台信息",
  schema: z.object({}), // 无需参数
  run: async () => {
    return {
      platform: os.platform(),
      release: os.release(),
      freeMemoryGB: (os.freemem() / 1024 ** 3).toFixed(2),
      totalMemoryGB: (os.totalmem() / 1024 ** 3).toFixed(2),
      cpuCores: os.cpus().length,
    };
  },
});

// 技能 B: 读写文件
registerSkill({
  name: "manage_file",
  description: "创建、读取或追加内容到本地文件",
  schema: z.object({
    path: z.string().describe("文件的路径或名称"),
    action: z.enum(["read", "write", "append"]).describe("操作类型"),
    content: z.string().optional().describe("写入或追加的内容"),
  }),
  run: async ({ path, action, content }) => {
    try {
      // const absolutePath = Buffer.from(path).toString(); // 简单的路径处理
      if (action === "write") {
        await fs.writeFile(path, content || "");
        // 这里的 resolve 会告诉你文件到底在哪
        const fullPath = await import('path').then(p => p.resolve(path));
        return { status: "success", message: `文件已写入到: ${fullPath}` };
      }
      // ... 其他逻辑
    } catch (error: any) {
      return { status: "error", message: error.message };
    }
  },
});

// --- 3. OpenClaw 推理核心 ---


async function runOpenClaw(prompt: string) {
  let messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: "你是一个高效的助理。如果用户要求写文件，请务必调用工具执行，不要只口头描述。" },
    { role: "user", content: prompt },
  ];

  // 将所有注册的技能映射为 OpenAI/DeepSeek 识别的 tools 格式
  const tools: OpenAI.Chat.ChatCompletionTool[] = Object.values(skillRegistry).map((skill) => {
    const jsonSchema = zodToJsonSchema(skill.schema as any) as any;

    // 关键修复：DeepSeek 要求 parameters 必须显式声明为 object
    // 如果 zod 转换出来没有 type，或者 type 为空，我们手动补齐
    const parameters = {
      type: "object",
      properties: jsonSchema.properties || {},
      required: jsonSchema.required || [],
    };

    return {
      type: "function",
      function: {
        name: skill.name,
        description: skill.description,
        parameters: parameters as any,
      },
    };
  });

  // 这里的循环让 AI 可以连续执行多个动作
  let keepRunning = true;
  let turnCount = 0; // 防止死循环

  while (keepRunning && turnCount < 10) {
    turnCount++;
    try {
      const response = await openai.chat.completions.create({
        model: "deepseek-chat",
        messages: messages, // 现在的 messages 应该是被清洗过的
        tools: tools,
      });

      const aiMessage = response.choices[0].message;

      // --- 【关键】深度清洗 Assistant 消息 ---
      const assistantMessage: any = {
        role: "assistant",
        content: aiMessage.content || "", // 强制为空字符串，绝不给 null
      };

      // 只有当有工具调用时才添加 tool_calls 字段
      if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
        assistantMessage.tool_calls = aiMessage.tool_calls;
      }

      messages.push(assistantMessage);

      if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
        for (const toolCall of aiMessage.tool_calls) {
          if (toolCall.type === 'function') {
            const functionName = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments);

            console.log(`🔧 [执行技能] ${functionName}...`);
            const skill = skillRegistry[functionName];
            const skillResult = await skill.run(args);

            // --- 【关键】深度清洗 Tool 消息 ---
            messages.push({
              role: "tool" as const,
              tool_call_id: toolCall.id,
              // 关键：即使 result 是空的，也要转成字符串 ""
              content: skillResult !== undefined && skillResult !== null
                ? (typeof skillResult === 'string' ? skillResult : JSON.stringify(skillResult))
                : "success" // 兜底字符串
            });
          }
        }
      } else {
        console.log(`✨ [AI 回复]: ${aiMessage.content}`);
        keepRunning = false;
      }
    } catch (error: any) {
      // 如果报错，我们打印出最后一次尝试发送的 messages 结构，方便断后
      console.error("❌ 运行时捕获到异常。最后一条消息结构：", JSON.stringify(messages[messages.length - 1], null, 2));
      console.dir(error, { depth: null });
      keepRunning = false;
    }
  }
}
import path from 'path';
console.log("-----------------------------------------");
console.log("🚀 你的 Agent 默认会把文件写在这里:");
console.log(path.resolve("sys_report.txt"));
console.log("-----------------------------------------");

// --- 4. 运行 Demo ---
runOpenClaw("必须执行以下两个步骤：1. 查内存。2. 必须调用 manage_file 技能把结果写进 sys_report.txt。");
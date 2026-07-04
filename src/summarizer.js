import { Storage } from './storage.js';
import { Anchor } from './anchor.js';

export class Summarizer {
    static pendingBatches = {};
    static pendingAudits = {};

    // 安排批小结（异步，不阻塞）
    static scheduleBatchSummary(role) {
        if (this.pendingBatches[role]) return;
        this.pendingBatches[role] = setTimeout(async () => {
            await this.runBatchSummary(role);
            delete this.pendingBatches[role];
        }, 1500); // 延迟1.5秒等待更多消息
    }

    static async runBatchSummary(role) {
        const messages = await Storage.getLastNMessages(role, 15);
        if (messages.length < 3) return;

        // 构造 LLM 调用
        const system = '你是一个剧情摘要助手。请将以下对话压缩为一段连贯的段落摘要，保留关键事件、人物状态和情感变化。同时提取关键词（逗号分隔）。';
        const user = messages.map(m => `${m.isUser ? '用户' : role}: ${m.content}`).join('\n');
        const prompt = [{ role: 'system', content: system }, { role: 'user', content: user }];

        const result = await this.callSummaryAPI(prompt);
        if (!result) return;

        // 解析结果（期望格式：摘要\n\n关键词：xxx, yyy, zzz）
        const parts = result.split('\n\n关键词：');
        const summary = parts[0].trim();
        const keywords = parts[1] ? parts[1].split(/[,，]/).map(k => k.trim()).filter(Boolean) : [];

        // 保存 L2 条目
        await Storage.saveL2Entry({
            role,
            content: summary,
            keywords,
            timestamp: Date.now(),
            turnRange: { start: messages[0].timestamp, end: messages[messages.length-1].timestamp }
        });

        // 检查是否需要生成 L3 目录（每 10 条 L2 触发一次）
        const l2Count = (await Storage.getAllL2(role)).length;
        if (l2Count % 10 === 0) {
            await this.generateL3Directory(role);
        }
    }

    static async generateL3Directory(role) {
        const allL2 = await Storage.getAllL2(role);
        const contents = allL2.map(e => e.content).join('\n---\n');
        const prompt = [
            { role: 'system', content: '请根据以下所有剧情摘要，生成一个带时间范围和主题索引的目录，便于后续快速定位。输出格式：每个条目一行，包含时间段、主要事件、涉及人物。' },
            { role: 'user', content: contents }
        ];
        const directory = await this.callSummaryAPI(prompt);
        if (directory) {
            await Storage.saveL3Directory(role, directory);
        }
    }

    // 一致性审计
    static scheduleAudit(role) {
        if (this.pendingAudits[role]) return;
        this.pendingAudits[role] = setTimeout(async () => {
            await this.runAudit(role);
            delete this.pendingAudits[role];
        }, 2000);
    }

    static async runAudit(role) {
        const core = await Storage.getCoreTraits(role);
        if (!core) return;

        const recentL2 = await Storage.getRecentL2(role, 10);
        if (recentL2.length === 0) return;

        const summaries = recentL2.map(e => e.content).join('\n---\n');
        const prompt = [
            { role: 'system', content: `你是一个角色一致性审计员。请根据以下角色核心设定和最近剧情摘要，评估角色行为是否与核心设定一致。\n核心设定：${JSON.stringify(core)}\n\n请输出格式：\n评分：X/10\n偏差描述：...\n修正建议：...` },
            { role: 'user', content: summaries }
        ];

        const result = await this.callSummaryAPI(prompt);
        if (!result) return;

        // 解析评分
        const scoreMatch = result.match(/评分[：:]?\s*(\d+)/i);
        const score = scoreMatch ? parseInt(scoreMatch[1]) : 5;

        // 记录审计日志
        await Storage.logAudit({ role, score, detail: result, timestamp: Date.now() });

        // 根据评分采取行动
        if (score <= 3) {
            // 重度偏离：准备修正指令
            const correction = `【角色一致性提醒】请注意，${role} 的核心设定如下：${JSON.stringify(core)}。近期行为出现了显著偏离。请在接下来的回复中回归核心设定。`;
            await Storage.setPendingCorrection(role, correction);
        } else if (score <= 6) {
            // 中度偏离：温和提醒
            const correction = `【提醒】请尽量保持 ${role} 的性格一致性，当前行为与核心设定略有偏差。`;
            await Storage.setPendingCorrection(role, correction);
        }
        // 轻度偏离不做处理
    }

    // 调用摘要 API（使用独立配置）
    static async callSummaryAPI(messages) {
        const settings = await loadSettings(); // 需要从 index.js 获取，简化起见直接读取全局
        const baseUrl = settings.summary_base_url || 'https://api.deepseek.com/v1';
        const apiKey = settings.summary_api_key || '';
        const model = settings.summary_model || 'deepseek-chat';

        try {
            const response = await fetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({ model, messages, max_tokens: 768, temperature: 0.3 })
            });
            if (!response.ok) return null;
            const data = await response.json();
            return data.choices?.[0]?.message?.content?.trim() || null;
        } catch (e) {
            console.error('[MemVault] Summary API call failed:', e);
            return null;
        }
    }
}

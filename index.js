import { getContext, eventSource, event_types } from '../../../script.js';
import { Storage } from './src/storage.js';
import { Summarizer } from './src/summarizer.js';
import { Retriever } from './src/retriever.js';
import { Anchor } from './src/anchor.js';
import { Isolation } from './src/isolation.js';

const EXTENSION_NAME = 'memvault';
let settings = {};

// 初始化
async function init() {
    settings = await loadSettings();
    await Storage.init(EXTENSION_NAME);
    await Anchor.init();
    await Isolation.init();

    // 注册消息钩子（采集 + 批调度 + 审计）
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.MESSAGE_SENT, onMessageSent);

    // 注册注入钩子（在 prompt 构建前注入记忆）
    eventSource.on(event_types.GENERATE_AFTER_PROMPT, onBeforeCompletion);
}

// 收到 AI 消息
async function onMessageReceived(data) {
    if (!data || data.isSystem) return;
    const role = data.name || 'Unknown';
    await Storage.appendRawMessage({ role, content: data.mes, timestamp: Date.now(), isUser: false });

    // 检查批处理阈值
    const count = await Storage.getMessageCount(role);
    if (count >= settings.batch_size) {
        Summarizer.scheduleBatchSummary(role);
    }

    // 检查审计间隔
    const total = await Storage.getTotalMessageCount();
    if (total % settings.audit_interval === 0 && settings.enable_anchor) {
        Summarizer.scheduleAudit(role);
    }
}

// 发送用户消息
async function onMessageSent(data) {
    if (!data || !data.mes) return;
    const role = data.name || 'User';
    await Storage.appendRawMessage({ role, content: data.mes, timestamp: Date.now(), isUser: true });
}

// 注入记忆（在 prompt 组装前）
async function onBeforeCompletion(args) {
    const context = getContext();
    const currentChar = context.characters?.[context.characterId]?.name;
    if (!currentChar) return;

    let injection = [];

    // 1. 核心设定（始终在最前）
    if (settings.enable_anchor) {
        const core = await Anchor.getCoreTraits(currentChar);
        if (core) injection.push(core);
    }

    // 2. 召回记忆（按角色隔离）
    if (settings.enable_isolation) {
        const memories = await Retriever.retrieveForCharacter(currentChar, args.userInput);
        if (memories) injection.push(memories);
    } else {
        const memories = await Retriever.retrieveGlobal(args.userInput);
        if (memories) injection.push(memories);
    }

    // 3. 审计修正（如果有）
    if (settings.enable_anchor) {
        const correction = await Anchor.getPendingCorrection(currentChar);
        if (correction) injection.push(correction);
    }

    if (injection.length > 0) {
        // 将注入内容附加到系统提示中
        const extPrompt = injection.join('\n\n');
        args.prompt = extPrompt + '\n\n' + args.prompt;
    }
}

// 设置面板
function getSettingsHtml() {
    return `
    <div id="memvault-settings">
        <h3>MemVault - 长效记忆与角色锚定</h3>
        <div class="settings_block">
            <label for="mv-summary-model">摘要专用模型</label>
            <input id="mv-summary-model" type="text" value="${settings.summary_model}"/>
        </div>
        <div class="settings_block">
            <label for="mv-summary-base-url">摘要API地址</label>
            <input id="mv-summary-base-url" type="url" value="${settings.summary_base_url}"/>
        </div>
        <div class="settings_block">
            <label for="mv-summary-api-key">摘要API Key</label>
            <input id="mv-summary-api-key" type="password" value="${settings.summary_api_key}"/>
        </div>
        <hr/>
        <div class="settings_block">
            <label for="mv-batch-size">批处理大小（消息数）</label>
            <input id="mv-batch-size" type="number" min="5" max="100" value="${settings.batch_size}"/>
        </div>
        <div class="settings_block">
            <label for="mv-audit-interval">审计间隔（轮数）</label>
            <input id="mv-audit-interval" type="number" min="10" max="500" value="${settings.audit_interval}"/>
        </div>
        <div class="settings_block">
            <label><input id="mv-enable-anchor" type="checkbox" ${settings.enable_anchor?'checked':''}/> 启用角色锚定</label>
        </div>
        <div class="settings_block">
            <label><input id="mv-enable-isolation" type="checkbox" ${settings.enable_isolation?'checked':''}/> 启用多角色隔离</label>
        </div>
        <div class="settings_block">
            <label for="mv-max-recall-tokens">召回注入最大Token数</label>
            <input id="mv-max-recall-tokens" type="number" min="256" max="4096" value="${settings.max_recall_tokens}"/>
        </div>
    </div>`;
}

async function onSettingsUpdate(newSettings) {
    settings = newSettings;
    await saveSettings(settings);
}

export default { init, getSettingsHtml, onSettingsUpdate };

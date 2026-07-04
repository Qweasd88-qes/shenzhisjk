import { Storage } from './storage.js';

export class Isolation {
    static async init() {}

    // 按角色分桶存储（已在 Storage 中通过 role 字段实现）
    // 跨角色知识传递：仅在剧情中明确发生时调用
    static async transferKnowledge(fromRole, toRole, key, value) {
        // 检查是否已被核心设定锁定
        const core = await Storage.getCoreTraits(toRole);
        if (core && key in core) {
            console.warn(`[MemVault] 无法向 ${toRole} 传递知识 "${key}"：该字段被核心设定锁定`);
            return false;
        }
        // 写入动态状态
        return await Storage.updateDynamicState(toRole, key, value);
    }
}

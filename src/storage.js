// 简化的 IndexedDB 封装，支持分桶、diff-only 写、锁定字段
export class Storage {
    static db = null;
    static DB_NAME = 'memvault';
    static VERSION = 1;

    static async init(extensionName) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.VERSION);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                // 原始消息桶（按角色分桶，但统一存储）
                if (!db.objectStoreNames.contains('raw_messages')) {
                    db.createObjectStore('raw_messages', { keyPath: 'id', autoIncrement: true });
                }
                // L2 摘要桶
                if (!db.objectStoreNames.contains('summaries_l2')) {
                    db.createObjectStore('summaries_l2', { keyPath: 'id', autoIncrement: true });
                }
                // L3 目录桶
                if (!db.objectStoreNames.contains('summaries_l3')) {
                    db.createObjectStore('summaries_l3', { keyPath: 'role' });
                }
                // 核心设定桶（锁定字段）
                if (!db.objectStoreNames.contains('core_traits')) {
                    db.createObjectStore('core_traits', { keyPath: 'role' });
                }
                // 动态状态桶
                if (!db.objectStoreNames.contains('dynamic_state')) {
                    db.createObjectStore('dynamic_state', { keyPath: 'role' });
                }
                // 审计日志桶
                if (!db.objectStoreNames.contains('audit_log')) {
                    db.createObjectStore('audit_log', { keyPath: 'id', autoIncrement: true });
                }
                // 修正指令桶
                if (!db.objectStoreNames.contains('pending_corrections')) {
                    db.createObjectStore('pending_corrections', { keyPath: 'role' });
                }
            };
            request.onsuccess = (e) => {
                this.db = e.target.result;
                resolve();
            };
            request.onerror = reject;
        });
    }

    // ---------- 原始消息 ----------
    static async appendRawMessage(msg) {
        const tx = this.db.transaction('raw_messages', 'readwrite');
        tx.objectStore('raw_messages').add(msg);
        await tx.done;
    }

    static async getMessageCount(role) {
        const tx = this.db.transaction('raw_messages', 'readonly');
        const store = tx.objectStore('raw_messages');
        const index = store.index('role'); // 需要先创建索引，简化起见我们遍历
        const all = await store.getAll();
        return all.filter(m => m.role === role).length;
    }

    static async getTotalMessageCount() {
        const tx = this.db.transaction('raw_messages', 'readonly');
        const store = tx.objectStore('raw_messages');
        const all = await store.getAll();
        return all.length;
    }

    static async getLastNMessages(role, n) {
        const tx = this.db.transaction('raw_messages', 'readonly');
        const store = tx.objectStore('raw_messages');
        const all = await store.getAll();
        const filtered = all.filter(m => m.role === role).slice(-n);
        return filtered;
    }

    // ---------- L2 摘要 ----------
    static async saveL2Entry(entry) {
        const tx = this.db.transaction('summaries_l2', 'readwrite');
        tx.objectStore('summaries_l2').add(entry);
        await tx.done;
    }

    static async getRecentL2(role, limit = 10) {
        const tx = this.db.transaction('summaries_l2', 'readonly');
        const store = tx.objectStore('summaries_l2');
        const all = await store.getAll();
        const filtered = all.filter(e => e.role === role).slice(-limit);
        return filtered;
    }

    static async getAllL2(role) {
        const tx = this.db.transaction('summaries_l2', 'readonly');
        const store = tx.objectStore('summaries_l2');
        const all = await store.getAll();
        return all.filter(e => e.role === role);
    }

    // ---------- L3 目录 ----------
    static async saveL3Directory(role, directory) {
        const tx = this.db.transaction('summaries_l3', 'readwrite');
        tx.objectStore('summaries_l3').put({ role, directory, timestamp: Date.now() });
        await tx.done;
    }

    static async getL3Directory(role) {
        const tx = this.db.transaction('summaries_l3', 'readonly');
        const store = tx.objectStore('summaries_l3');
        return await store.get(role);
    }

    // ---------- 核心设定（锁定字段） ----------
    static async getCoreTraits(role) {
        const tx = this.db.transaction('core_traits', 'readonly');
        const store = tx.objectStore('core_traits');
        const record = await store.get(role);
        return record ? record.traits : null;
    }

    static async setCoreTraits(role, traits) {
        const tx = this.db.transaction('core_traits', 'readwrite');
        tx.objectStore('core_traits').put({ role, traits, lastModified: Date.now() });
        await tx.done;
    }

    // ---------- 动态状态（diff-only 写） ----------
    static async updateDynamicState(role, field, value) {
        const tx = this.db.transaction('dynamic_state', 'readwrite');
        const store = tx.objectStore('dynamic_state');
        let record = await store.get(role) || { role, state: {} };
        // 检查是否被核心设定锁定
        const core = await this.getCoreTraits(role);
        if (core && field in core) {
            console.warn(`[MemVault] 字段 "${field}" 已被核心设定锁定，拒绝自动修改`);
            return false;
        }
        record.state[field] = value;
        await store.put(record);
        return true;
    }

    static async getDynamicState(role) {
        const tx = this.db.transaction('dynamic_state', 'readonly');
        const store = tx.objectStore('dynamic_state');
        const record = await store.get(role);
        return record ? record.state : {};
    }

    // ---------- 审计日志 ----------
    static async logAudit(entry) {
        const tx = this.db.transaction('audit_log', 'readwrite');
        tx.objectStore('audit_log').add(entry);
        await tx.done;
    }

    static async getRecentAuditLogs(limit = 20) {
        const tx = this.db.transaction('audit_log', 'readonly');
        const store = tx.objectStore('audit_log');
        const all = await store.getAll();
        return all.slice(-limit);
    }

    // ---------- 修正指令 ----------
    static async setPendingCorrection(role, correction) {
        const tx = this.db.transaction('pending_corrections', 'readwrite');
        tx.objectStore('pending_corrections').put({ role, correction, timestamp: Date.now() });
        await tx.done;
    }

    static async getPendingCorrection(role) {
        const tx = this.db.transaction('pending_corrections', 'readonly');
        const store = tx.objectStore('pending_corrections');
        const record = await store.get(role);
        return record ? record.correction : null;
    }

    static async clearPendingCorrection(role) {
        const tx = this.db.transaction('pending_corrections', 'readwrite');
        tx.objectStore('pending_corrections').delete(role);
        await tx.done;
    }
}

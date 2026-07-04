import { Storage } from './storage.js';

// 简单 BM25 实现（内联，无需 npm）
class BM25 {
    constructor(docs) {
        this.k1 = 1.5;
        this.b = 0.75;
        this.docs = docs;
        this.docCount = docs.length;
        this.avgDocLen = docs.reduce((sum, d) => sum + d.length, 0) / this.docCount;
        this.termFreq = {};
        this.docFreq = {};
        this.buildIndex();
    }

    buildIndex() {
        for (let i = 0; i < this.docs.length; i++) {
            const terms = this.tokenize(this.docs[i]);
            const uniqueTerms = new Set(terms);
            for (const term of uniqueTerms) {
                if (!this.docFreq[term]) this.docFreq[term] = 0;
                this.docFreq[term]++;
            }
            for (const term of terms) {
                if (!this.termFreq[i]) this.termFreq[i] = {};
                this.termFreq[i][term] = (this.termFreq[i][term] || 0) + 1;
            }
        }
    }

    tokenize(text) {
        return text.toLowerCase().split(/[\s,.\!?;:()\[\]{}'"]+/).filter(t => t.length > 1);
    }

    score(query, docIndex) {
        const queryTerms = this.tokenize(query);
        let score = 0;
        const docLen = this.docs[docIndex].length;
        for (const term of queryTerms) {
            if (!this.docFreq[term]) continue;
            const idf = Math.log(1 + (this.docCount - this.docFreq[term] + 0.5) / (this.docFreq[term] + 0.5));
            const tf = this.termFreq[docIndex][term] || 0;
            score += idf * (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * docLen / this.avgDocLen));
        }
        return score;
    }

    search(query, topK = 30) {
        const scores = this.docs.map((_, idx) => ({ idx, score: this.score(query, idx) }));
        scores.sort((a, b) => b.score - a.score);
        return scores.slice(0, topK).map(s => ({ idx: s.idx, score: s.score }));
    }
}

export class Retriever {
    static async retrieveForCharacter(role, userInput) {
        // 1. 获取该角色的所有 L2 摘要
        const l2Entries = await Storage.getAllL2(role);
        if (l2Entries.length === 0) return null;

        const docs = l2Entries.map(e => e.content);
        const bm25 = new BM25(docs);
        const bm25Results = bm25.search(userInput, 30);

        // 2. 简单向量检索（使用词袋余弦相似度作为替代，实际可替换为 vectra）
        const queryVec = this.textToVector(userInput);
        const docVecs = docs.map(d => this.textToVector(d));
        const similarities = docVecs.map((vec, idx) => ({
            idx,
            similarity: this.cosineSimilarity(queryVec, vec)
        }));
        similarities.sort((a, b) => b.similarity - a.similarity);
        const topVec = similarities.slice(0, 10);

        // 3. 融合 BM25 和向量结果（加权平均）
        const combinedScores = {};
        for (const r of bm25Results) {
            combinedScores[r.idx] = (combinedScores[r.idx] || 0) + r.score * 0.6;
        }
        for (const r of topVec) {
            combinedScores[r.idx] = (combinedScores[r.idx] || 0) + r.similarity * 0.4;
        }

        // 4. 时间衰减
        const now = Date.now();
        const scored = Object.entries(combinedScores).map(([idxStr, score]) => {
            const idx = parseInt(idxStr);
            const entry = l2Entries[idx];
            const ageMs = now - entry.timestamp;
            const ageDays = ageMs / (1000 * 86400);
            const decay = Math.exp(-ageDays / 7); // 半衰期7天
            return { entry, score: score * decay };
        });

        scored.sort((a, b) => b.score - a.score);

        // 5. 按 token 预算截取
        let totalTokens = 0;
        const selected = [];
        for (const item of scored) {
            const tokens = Math.ceil(item.entry.content.length / 4);
            if (totalTokens + tokens > 1536) break; // 使用默认值，实际可从设置读取
            selected.push(item.entry.content);
            totalTokens += tokens;
        }

        return selected.length > 0 ? selected.join('\n\n') : null;
    }

    static textToVector(text) {
        const words = text.toLowerCase().split(/[\s,.\!?;:()\[\]{}'"]+/).filter(t => t.length > 1);
        const freq = {};
        for (const w of words) freq[w] = (freq[w] || 0) + 1;
        return freq;
    }

    static cosineSimilarity(vecA, vecB) {
        const keys = new Set([...Object.keys(vecA), ...Object.keys(vecB)]);
        let dot = 0, normA = 0, normB = 0;
        for (const k of keys) {
            const a = vecA[k] || 0;
            const b = vecB[k] || 0;
            dot += a * b;
            normA += a * a;
            normB += b * b;
        }
        if (normA === 0 || normB === 0) return 0;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }
}

/**
 * search.js — 简单关键词 + 标签过滤
 */

/**
 * 对记忆列表做过滤
 * @param {Array} list
 * @param {string} query  — 关键词（空则不过滤）
 * @param {string[]} tags — 标签白名单（空数组则不过滤）
 * @returns {Array}
 */
export function filterMemories(list, query, tags) {
    let result = list;
    if (query && query.trim()) {
        const q = query.trim().toLowerCase();
        const numVal = parseFloat(q);
        const isNumQuery = !isNaN(numVal) && numVal >= 0 && numVal <= 1;
        result = result.filter(e => {
            if (isNumQuery) {
                if (Math.abs(e.importance - numVal) < 0.05) return true;
            }
            return e.content.toLowerCase().includes(q) ||
                   e.tags.some(t => t.toLowerCase().includes(q));
        });
    }
    if (tags && tags.length) {
        result = result.filter(e =>
            tags.every(t => e.tags.includes(t))
        );
    }
    return result;
}

/**
 * 从当前记忆列表中收集所有已有标签
 */
export function collectAllTags(list) {
    const set = new Set();
    for (const e of list) for (const t of e.tags) set.add(t);
    return [...set].sort();
}

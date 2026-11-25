/**
 * inject.js — 把记忆注入 ST prompt（使用 setExtensionPrompt）
 *
 * 设计不变量（对照 SillyTavern 1.19.1 public/script.js）：
 * - extension_prompt_types.NONE          = -1
 * - extension_prompt_types.IN_PROMPT     = 0  （主提示词 / 角色卡定义之后）
 * - extension_prompt_types.IN_CHAT       = 1  （聊天记录中，配合 depth 控制位置）
 * - extension_prompt_types.BEFORE_PROMPT = 2  （主提示词之前）
 * - 多分区注入时，每条记忆使用其所属分区的自定义标签名包裹。
 */

import {
    getPinnedSorted, getRecentUnpinned, loadMemories,
    normalizeZones, getEntryZoneId,
} from './memory.js';

const INJECTION_KEY = 'memory-vault';

export function buildPromptText(list, settings) {
    const { recentN = 5, pinnedFirst = true, injectFormat = 'lenitxt' } = settings;
    const zones = normalizeZones(settings.zones);
    const zoneTagMap = new Map(zones.map(z => [z.id, z.tag]));
    const defaultTag = zones[0].tag;

    const pinned = getPinnedSorted(list);
    const unpinned = getRecentUnpinned(list);
    const recent = recentN === 0 ? unpinned : unpinned.slice(-recentN);

    const ordered = pinnedFirst
        ? [...pinned, ...recent]
        : [...recent, ...pinned];

    if (!ordered.length) return '';

    const formatLine = (e, lastDate) => {
        const dateStr = (e.date === lastDate) ? '' : e.date;
        const tagsStr = (e.tags || []).join(',');
        return dateStr
            ? `${dateStr}|${tagsStr}|${e.content}`
            : `|${tagsStr}|${e.content}`;
    };

    if (injectFormat === 'plain') {
        const lines = [];
        let lastDate = null;
        for (const e of ordered) {
            lines.push(formatLine(e, lastDate));
            lastDate = e.date;
        }
        return lines.join('\n');
    }

    if (injectFormat === 'lenitxt_single') {
        // 按所属分区标签分组包裹；单分区时仅包裹一次，多分区时各自用对应标签包裹
        const groups = [];
        for (const e of ordered) {
            const zId = getEntryZoneId(e, zones);
            const tag = zoneTagMap.get(zId) || defaultTag;
            let grp = groups.find(g => g.tag === tag);
            if (!grp) {
                grp = { tag, entries: [] };
                groups.push(grp);
            }
            grp.entries.push(e);
        }
        return groups.map(g => {
            const lines = [];
            let lastDate = null;
            for (const e of g.entries) {
                lines.push(formatLine(e, lastDate));
                lastDate = e.date;
            }
            return `<${g.tag}>\n${lines.join('\n')}\n</${g.tag}>`;
        }).join('\n');
    }

    // 默认 'lenitxt' 模式：逐条用所属分区的自定义标签包裹
    const lines = [];
    let lastDate = null;
    for (const e of ordered) {
        const zId = getEntryZoneId(e, zones);
        const tag = zoneTagMap.get(zId) || defaultTag;
        lines.push(`<${tag}>${formatLine(e, lastDate)}</${tag}>`);
        lastDate = e.date;
    }
    return lines.join('\n');
}

function getSetExtensionPrompt() {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx?.setExtensionPrompt === 'function') return ctx.setExtensionPrompt.bind(ctx);
    } catch {}
    if (typeof window !== 'undefined' && typeof window.setExtensionPrompt === 'function') {
        return window.setExtensionPrompt;
    }
    return null;
}

export function updateInjection(vaultId, settings) {
    try {
        const fn = getSetExtensionPrompt();
        if (!fn) return;
        const list = loadMemories(vaultId);
        const text = buildPromptText(list, settings);
        const { position, depth } = resolvePosition(settings.injectionPosition);
        fn(INJECTION_KEY, text, position, depth);
    } catch (e) {
        console.warn('[MemoryVault] inject 失败:', e);
    }
}

export function clearInjection() {
    try {
        const fn = getSetExtensionPrompt();
        if (fn) fn(INJECTION_KEY, '', 0, 0);
    } catch {}
}

export function resolvePosition(pos) {
    let types = null;
    try {
        types = SillyTavern.getContext()?.extension_prompt_types ?? null;
    } catch {}

    const IN_PROMPT     = types?.IN_PROMPT     ?? 0;
    const IN_CHAT       = types?.IN_CHAT       ?? 1;
    const BEFORE_PROMPT = types?.BEFORE_PROMPT ?? 2;

    const MAP = {
        in_chat:       { position: IN_CHAT,       depth: 9999 },
        before_prompt: { position: BEFORE_PROMPT, depth: 0 },
        after_char:    { position: IN_PROMPT,     depth: 0 },
        authors_note:  { position: IN_CHAT,       depth: 4 },
    };
    return MAP[pos] ?? { position: IN_CHAT, depth: 9999 };
}
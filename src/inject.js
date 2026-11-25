/**
 * inject.js — 把记忆注入 ST prompt（使用 setExtensionPrompt）
 *
 * 设计不变量（对照 SillyTavern 1.19.1 public/script.js）：
 * - extension_prompt_types.NONE          = -1
 * - extension_prompt_types.IN_PROMPT     = 0  （主提示词 / 角色卡定义之后）
 * - extension_prompt_types.IN_CHAT       = 1  （聊天记录中，配合 depth 控制位置）
 * - extension_prompt_types.BEFORE_PROMPT = 2  （主提示词之前）
 */

import { getPinnedSorted, getRecentUnpinned, loadMemories } from './memory.js';

const INJECTION_KEY = 'memory-vault';

export function buildPromptText(list, settings) {
    const { recentN = 5, pinnedFirst = true, injectFormat = 'lenitxt' } = settings;

    const pinned = getPinnedSorted(list);
    const unpinned = getRecentUnpinned(list, recentN);
    const recent = recentN === 0 ? unpinned : unpinned.slice(-recentN);

    const ordered = pinnedFirst
        ? [...pinned, ...recent]
        : [...recent, ...pinned];

    // 没有可注入记忆时返回空字符串，避免注入空的 <Lenitxt></Lenitxt> 标签
    if (!ordered.length) return '';

    const lines = [];
    let lastDate = null;
    for (const e of ordered) {
        const dateStr = (e.date === lastDate) ? '' : e.date;
        const tagsStr = (e.tags || []).join(',');
        const plainLine = dateStr
            ? `${dateStr}|${tagsStr}|${e.content}`
            : `|${tagsStr}|${e.content}`;
        if (injectFormat === 'plain' || injectFormat === 'lenitxt_single') {
            lines.push(plainLine);
        } else {
            lines.push(`<Lenitxt>${plainLine}</Lenitxt>`);
        }
        lastDate = e.date;
    }
    const joined = lines.join('\n');
    return injectFormat === 'lenitxt_single' ? `<Lenitxt>\n${joined}\n</Lenitxt>` : joined;
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
        in_chat:       { position: IN_CHAT,       depth: 9999 }, // 聊天记录最前方
        before_prompt: { position: BEFORE_PROMPT, depth: 0 },    // 主提示词之前
        after_char:    { position: IN_PROMPT,     depth: 0 },    // 角色卡 / 主提示词之后
        authors_note:  { position: IN_CHAT,       depth: 4 },    // 聊天内深度 4（兼容作者注释位置）
    };
    return MAP[pos] ?? { position: IN_CHAT, depth: 9999 };
}
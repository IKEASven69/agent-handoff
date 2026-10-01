/**
 * 迷你 YAML 子集解析/输出：只覆盖本协议 frontmatter 用到的形态——
 * 标量、一层嵌套 map、flow map `{a: b}`、flow 列表 `[a, b]`、
 * 块式字符串数组、块式对象数组（tasks）。不引 yaml 包（零依赖纪律）。
 */
/** 去掉空行与整行注释，记录缩进 */
function linesOf(src) {
    const out = [];
    for (const raw of src.split(/\r?\n/)) {
        if (raw.trim() === '')
            continue;
        const text = raw.trimStart();
        if (text.startsWith('#'))
            continue;
        out.push({ indent: raw.length - text.length, text });
    }
    return out;
}
/** 解析 frontmatter 文本为顶层 map */
export function yamlParse(src) {
    const lines = linesOf(src);
    if (lines.length === 0)
        return {};
    const [v] = parseBlock(lines, 0, lines[0].indent);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        throw new Error('frontmatter 顶层必须是键值对');
    }
    return v;
}
function parseBlock(lines, i, indent) {
    if (i >= lines.length)
        return [null, i];
    if (lines[i].text.startsWith('- ') || lines[i].text === '-')
        return parseList(lines, i, indent);
    return parseMap(lines, i, indent);
}
/** 键行：`key:` 或 `key: value`，key 不含冒号 */
const KEY_LINE = /^([^:]+?):(?:\s+(.*))?$/;
function isKeyLine(s) {
    // 带引号的字符串列表项（如 `- "weird: name.ts"`）不是键值行
    return KEY_LINE.test(s) && !s.startsWith('{') && !s.startsWith('"') && !s.startsWith("'");
}
function parseMap(lines, start, indent) {
    const obj = {};
    let i = start;
    while (i < lines.length) {
        const ln = lines[i];
        if (ln.indent < indent)
            break;
        if (ln.indent > indent)
            throw new Error(`YAML 缩进错误：${ln.text}`);
        if (ln.text.startsWith('- ') || ln.text === '-')
            break; // 列表交还上层
        const m = KEY_LINE.exec(ln.text);
        if (!m)
            throw new Error(`YAML 行无法解析：${ln.text}`);
        const key = unquote(m[1].trim());
        const rest = m[2];
        if (rest === undefined) {
            // 值在后续更深缩进的块里，或为 null
            if (i + 1 < lines.length && lines[i + 1].indent > indent) {
                const [v, ni] = parseBlock(lines, i + 1, lines[i + 1].indent);
                obj[key] = v;
                i = ni;
            }
            else {
                obj[key] = null;
                i++;
            }
        }
        else {
            obj[key] = parseInline(rest);
            i++;
        }
    }
    return [obj, i];
}
function parseList(lines, start, indent) {
    const arr = [];
    let i = start;
    while (i < lines.length) {
        const ln = lines[i];
        if (ln.indent < indent)
            break;
        if (ln.indent > indent)
            throw new Error(`YAML 列表缩进错误：${ln.text}`);
        if (!ln.text.startsWith('- ') && ln.text !== '-')
            break;
        const dash = ln.text === '-' ? '' : ln.text.slice(2);
        if (dash === '') {
            // 嵌套块（更深缩进）
            if (i + 1 < lines.length && lines[i + 1].indent > ln.indent) {
                const [v, ni] = parseBlock(lines, i + 1, lines[i + 1].indent);
                arr.push(v);
                i = ni;
            }
            else {
                arr.push(null);
                i++;
            }
        }
        else if (isKeyLine(dash)) {
            // 对象数组项：`- key: value` + 后续更深缩进的同项键
            const sub = [{ indent: ln.indent + 2, text: dash }];
            let j = i + 1;
            while (j < lines.length && lines[j].indent > ln.indent) {
                sub.push(lines[j]);
                j++;
            }
            const [v] = parseMap(sub, 0, ln.indent + 2);
            arr.push(v);
            i = j;
        }
        else {
            arr.push(parseInline(dash));
            i++;
        }
    }
    return [arr, i];
}
/** 解析行内值：flow map / flow 列表 / 引号字符串 / 数字 / 布尔 / 裸字符串 */
function parseInline(raw) {
    const s = raw.trim();
    if (s.startsWith('{'))
        return parseFlowMap(s);
    if (s.startsWith('['))
        return parseFlowList(s);
    if (s.startsWith('"'))
        return parseDoubleQuoted(s);
    if (s.startsWith("'"))
        return parseSingleQuoted(s);
    const bare = stripComment(s);
    if (bare === '' || bare === '~' || bare === 'null')
        return null;
    if (bare === 'true')
        return true;
    if (bare === 'false')
        return false;
    if (/^-?\d+$/.test(bare))
        return parseInt(bare, 10);
    if (/^-?\d*\.\d+$/.test(bare))
        return parseFloat(bare);
    return bare;
}
/** 裸标量去掉行尾注释（` #...`） */
function stripComment(s) {
    const at = s.indexOf(' #');
    return (at === -1 ? s : s.slice(0, at)).trim();
}
/** 顶层逗号切分（尊重引号与 {}[] 嵌套） */
function splitTopLevel(s, sep) {
    const out = [];
    let depth = 0;
    let quote = null;
    let cur = '';
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quote === '"') {
            cur += c;
            if (c === '\\') {
                cur += s[++i] ?? '';
            }
            else if (c === '"')
                quote = null;
            continue;
        }
        if (quote === "'") {
            cur += c;
            if (c === "'")
                quote = null;
            continue;
        }
        if (c === '"' || c === "'") {
            quote = c;
            cur += c;
        }
        else if (c === '{' || c === '[') {
            depth++;
            cur += c;
        }
        else if (c === '}' || c === ']') {
            depth--;
            cur += c;
        }
        else if (c === sep && depth === 0) {
            out.push(cur);
            cur = '';
        }
        else {
            cur += c;
        }
    }
    if (cur.trim() !== '')
        out.push(cur);
    return out;
}
function parseFlowMap(s) {
    const end = s.lastIndexOf('}');
    if (end === -1)
        throw new Error(`flow map 缺少 }：${s}`);
    const inner = s.slice(1, end);
    const obj = {};
    for (const entry of splitTopLevel(inner, ',')) {
        const colon = entry.indexOf(':');
        if (colon === -1)
            throw new Error(`flow map 项无法解析：${entry}`);
        const key = unquote(entry.slice(0, colon).trim());
        const val = entry.slice(colon + 1).trim();
        obj[key] = val === '' ? null : parseInline(val);
    }
    return obj;
}
function parseFlowList(s) {
    const end = s.lastIndexOf(']');
    if (end === -1)
        throw new Error(`flow 列表缺少 ]：${s}`);
    const inner = s.slice(1, end).trim();
    if (inner === '')
        return [];
    return splitTopLevel(inner, ',').map(x => parseInline(x));
}
function parseDoubleQuoted(s) {
    let out = '';
    let i = 1;
    for (; i < s.length; i++) {
        const c = s[i];
        if (c === '\\' && i + 1 < s.length) {
            const n = s[++i];
            out += n === 'n' ? '\n' : n === 't' ? '\t' : n; // \" \\ \/ 等原样取转义后字符
        }
        else if (c === '"') {
            return out;
        }
        else {
            out += c;
        }
    }
    throw new Error('双引号字符串未闭合');
}
function parseSingleQuoted(s) {
    // YAML 单引号字符串里 '' 是转义的单个引号，不能见到第一个 ' 就收尾
    let out = '';
    for (let i = 1; i < s.length; i++) {
        if (s[i] === "'") {
            if (s[i + 1] === "'") {
                out += "'";
                i++;
            }
            else {
                return out;
            }
        }
        else {
            out += s[i];
        }
    }
    throw new Error('单引号字符串未闭合');
}
function unquote(s) {
    if (s.startsWith('"'))
        return parseDoubleQuoted(s);
    if (s.startsWith("'"))
        return parseSingleQuoted(s);
    return s;
}
// ---------- 输出 ----------
const isScalar = (v) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
/** 裸写会歧义就加双引号（过度加引号是安全的，解析器认） */
function needsQuote(s) {
    if (s === '')
        return true;
    if (/^\s|\s$/.test(s))
        return true;
    if (/^(true|false|null|~)$/.test(s))
        return true;
    if (/^-?[\d.]+$/.test(s))
        return true;
    // 控制字符必须进引号走转义，否则裸写产出不可解析 YAML
    if (/[\n\r\t]/.test(s))
        return true;
    return /[:"'#{}[\],&*!|>%@`?]/.test(s) || s.startsWith('-');
}
function emitScalar(v) {
    if (v === null)
        return '';
    if (typeof v === 'number' || typeof v === 'boolean')
        return String(v);
    if (!needsQuote(v))
        return v;
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}
/** key 校验：含冒号/空白/引号的 key 会在回读时静默错位，直接拒写（协议键均为安全形态） */
const SAFE_KEY = /^[A-Za-z0-9_.\-]+$/;
function emitKey(k) {
    if (!SAFE_KEY.test(k))
        throw new Error(`YAML 键无法安全输出：${k}（键只允许字母、数字、_ . -）`);
    return k;
}
function emitMap(obj, indent) {
    const pad = ' '.repeat(indent);
    const out = [];
    for (const [k, raw] of Object.entries(obj)) {
        if (raw === undefined)
            continue;
        const key = emitKey(k);
        const v = raw;
        if (isScalar(v)) {
            out.push(`${pad}${key}: ${emitScalar(v)}`.trimEnd());
        }
        else if (Array.isArray(v)) {
            if (v.length === 0) {
                out.push(`${pad}${key}: []`);
            }
            else if (v.every(x => isScalar(x))) {
                out.push(`${pad}${key}:`);
                for (const x of v)
                    out.push(`${pad}  - ${emitScalar(x)}`);
            }
            else {
                // 对象数组：首键与 - 同行，其余键对齐
                out.push(`${pad}${key}:`);
                for (const item of v) {
                    const entries = Object.entries(item).filter(([, val]) => val !== undefined);
                    entries.forEach(([ek, ev], idx) => {
                        const ekey = emitKey(ek);
                        const prefix = idx === 0 ? `${pad}  - ` : `${pad}    `;
                        if (isScalar(ev)) {
                            out.push(`${prefix}${ekey}: ${emitScalar(ev)}`.trimEnd());
                        }
                        else {
                            out.push(`${prefix}${ekey}:`);
                            out.push(...emitMap(ev, indent + 6));
                        }
                    });
                }
            }
        }
        else {
            out.push(`${pad}${key}:`);
            out.push(...emitMap(v, indent + 2));
        }
    }
    return out;
}
/** 块式 YAML 输出（不带 --- 边界） */
export function yamlEmit(obj) {
    return emitMap(obj, 0).join('\n');
}
//# sourceMappingURL=yaml.js.map
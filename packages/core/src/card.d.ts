/** 卡片渲染与解析：严格模式（parseCard）与宽松模式（parseCardLenient，语义 3） */
import type { Card, CardSections } from './types.js';
import { type YamlValue } from './yaml.js';
/** 六段固定顺序 + 可选「建议加载」 */
export declare const SECTION_KEYS: readonly ['goal', 'files', 'done', 'remaining', 'stopped', 'warnings'];
/** 生成卡片 id：ho-<时间戳36进制>-<随机4位> */
export declare function generateId(): string;
/** 合法卡片 id 形态（与文件名规则一致，拒绝路径穿越等外来 id） */
export declare const SAFE_ID: RegExp;
/** id 入口闸：loadCard/writeCard 落盘前必过，不合规直接报中文错 */
export declare function assertSafeId(id: string): void;
/** 解析正文六段：按 `## 标题` 切，缺段给空，未知段忽略 */
export declare function parseSections(body: string): CardSections;
/** frontmatter map → Card：缺字段给默认值，未知字段保留（版本纪律） */
export declare function frontmatterToCard(obj: Record<string, YamlValue>, sections: CardSections, fallbackId?: string): Card;
/** Card → frontmatter map（键序固定，extras 殿后） */
export declare function cardToFrontmatter(card: Card): Record<string, YamlValue>;
/** 渲染规范卡片文本：frontmatter（块式 YAML）+ 六段正文（顺序固定） */
export declare function renderCard(card: Card): string;
/** 严格模式：必须有 frontmatter；缺字段仍给默认值（版本纪律） */
export declare function parseCard(text: string): Card;
/**
 * 宽松模式（语义 3）：无 frontmatter 的纯 Markdown 也能解析——
 * 六段缺段给空，id 从文件名取或按规则生成。兼容 Matt Pocock 式临时卡片。
 */
export declare function parseCardLenient(text: string, hint?: {
    filename?: string;
}): Card;
//# sourceMappingURL=card.d.ts.map
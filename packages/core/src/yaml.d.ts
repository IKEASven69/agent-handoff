/**
 * 迷你 YAML 子集解析/输出：只覆盖本协议 frontmatter 用到的形态——
 * 标量、一层嵌套 map、flow map `{a: b}`、flow 列表 `[a, b]`、
 * 块式字符串数组、块式对象数组（tasks）。不引 yaml 包（零依赖纪律）。
 */
export type YamlValue = string | number | boolean | null | YamlValue[] | {
    [k: string]: YamlValue;
};
/** 解析 frontmatter 文本为顶层 map */
export declare function yamlParse(src: string): Record<string, YamlValue>;
/** 块式 YAML 输出（不带 --- 边界） */
export declare function yamlEmit(obj: Record<string, YamlValue>): string;
//# sourceMappingURL=yaml.d.ts.map
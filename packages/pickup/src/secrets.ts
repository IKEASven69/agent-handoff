/**
 * save 侧密钥扫描（写卡薄守门之一）：dsh-takeover/src/secretscan.ts 高置信模式的高置信子集
 * （8 条：AWS×2 / GitHub×2 / OpenAI / Anthropic / 私钥头 / JWT）。
 *
 * 判据遵循先例共识（gitleaks / GitHub Push Protection / git-secrets）：高置信模式，命中即报。
 * 卡文本由模型手写、随收件箱跨 agent 传播并进入下游会话上下文——比 git 更宽的泄漏面
 * （git 仓有 gitleaks 守，交接盘什么都没有）。误报由用户改卡 redact 后重试兜底，不静默放行。
 * 纯函数零依赖，确定性：同一输入永远同一输出。
 */

export interface SecretHit {
  /** 命中规则名（中文，供人读） */
  rule: string
  /** 命中串的掩码预览（只露前 4 后 2，中间打码） */
  masked: string
}

/** 高置信模式：命中即报（每条一个正则 + 规则名），抄自 dsh-takeover/src/secretscan.ts */
const PATTERNS: Array<{ rule: string; re: RegExp }> = [
  { rule: 'AWS Access Key（AKIA…）', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { rule: 'AWS 临时凭证（ASIA…）', re: /\bASIA[0-9A-Z]{16}\b/g },
  { rule: 'GitHub token（ghp_/gho_/ghu_/ghs_/ghr_）', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { rule: 'GitHub fine-grained PAT（github_pat_…）', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { rule: 'OpenAI 风格 key（sk-…）', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { rule: 'Anthropic API key（sk-ant-…）', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { rule: '私钥文件头', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { rule: 'JWT（eyJ 头部.载荷.签名）', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
]

/** 掩码预览：只露前 4 后 2，中间打码（回喂理由里不给完整泄漏串） */
export function maskPreview(s: string): string {
  if (s.length <= 8) return '*'.repeat(s.length)
  return `${s.slice(0, 4)}${'*'.repeat(Math.max(3, s.length - 6))}${s.slice(-2)}`
}

/** 扫描卡片全文（frontmatter + 六段正文）；返回全部命中（空数组 = 干净） */
export function scanSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = []
  const seen = new Set<string>()
  for (const { rule, re } of PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (!seen.has(m[0])) {
        seen.add(m[0])
        hits.push({ rule, masked: maskPreview(m[0]) })
      }
    }
  }
  return hits
}

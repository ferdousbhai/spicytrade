import { isCitablePageAddress } from './https-url'

/*
 * The subset of Markdown a thesis may use, parsed into a tree the site renders itself. A thesis
 * is model output, so it is never handed to an HTML renderer: headings, bold, italic, bullet and
 * ordered lists, and links to citable https pages are the whole vocabulary. A code span is
 * unwrapped to its plain text rather than styled, and anything else is shown as the text it is.
 */

export type ThesisInline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: ThesisInline[] }
  | { kind: 'em'; children: ThesisInline[] }
  | { kind: 'link'; href: string; children: ThesisInline[] }

type ThesisBlock =
  | { kind: 'heading'; inlines: ThesisInline[] }
  | { kind: 'paragraph'; inlines: ThesisInline[] }
  | { kind: 'list'; ordered: boolean; items: ThesisInline[][] }

const BULLET = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.*)$/
const ORDERED = /^\s*\d{1,2}[.)]\s/
const HEADING = /^\s*#{1,6}\s+(.*)$/

export function parseThesisMarkdown(text: string): ThesisBlock[] {
  const blocks: ThesisBlock[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | undefined

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', inlines: parseInlines(paragraph.join('\n')) })
    paragraph = []
  }
  const flushList = () => {
    if (list) blocks.push({ kind: 'list', ordered: list.ordered, items: list.items.map(parseInlines) })
    list = undefined
  }

  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim()) {
      flushParagraph()
      flushList()
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      blocks.push({ kind: 'heading', inlines: parseInlines(heading[1] ?? '') })
      continue
    }
    const bullet = BULLET.exec(line)
    if (bullet) {
      flushParagraph()
      const ordered = ORDERED.test(line)
      if (!list || list.ordered !== ordered) {
        flushList()
        list = { ordered, items: [] }
      }
      list.items.push(bullet[1] ?? '')
      continue
    }
    flushList()
    paragraph.push(line.trim())
  }
  flushParagraph()
  flushList()
  return blocks
}

const LINK = /\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/
const STRONG = /\*\*([^*]+)\*\*/
const EM = /(?<![\w*])[*_]([^*_\n]+)[*_](?![\w*])/
const CODE = /`([^`]+)`/

/** Earliest match wins; a tag that never closes stays literal. */
function parseInlines(text: string): ThesisInline[] {
  const out: ThesisInline[] = []
  let rest = text
  while (rest.length) {
    const candidates = [
      { match: LINK.exec(rest), kind: 'link' as const },
      { match: STRONG.exec(rest), kind: 'strong' as const },
      { match: EM.exec(rest), kind: 'em' as const },
      { match: CODE.exec(rest), kind: 'code' as const },
    ].filter((candidate): candidate is { match: RegExpExecArray; kind: 'link' | 'strong' | 'em' | 'code' } => candidate.match !== null)
    if (!candidates.length) {
      out.push({ kind: 'text', text: rest })
      break
    }
    const first = candidates.reduce((best, candidate) => candidate.match.index < best.match.index ? candidate : best)
    const { match, kind } = first
    if (match.index > 0) out.push({ kind: 'text', text: rest.slice(0, match.index) })
    // A link is published as an href only when its address is one a citation may name; any
    // other https string keeps its bracketed text as plain text and loses the address.
    if (kind === 'link') {
      if (isCitablePageAddress(match[2]!)) out.push({ kind: 'link', href: match[2]!, children: parseInlines(match[1]!) })
      else out.push(...parseInlines(match[1]!))
    }
    else if (kind === 'strong') out.push({ kind: 'strong', children: parseInlines(match[1]!) })
    else if (kind === 'em') out.push({ kind: 'em', children: parseInlines(match[1]!) })
    else out.push({ kind: 'text', text: match[1]! })
    rest = rest.slice(match.index + match[0].length)
  }
  return mergeText(out)
}

function mergeText(inlines: ThesisInline[]): ThesisInline[] {
  const merged: ThesisInline[] = []
  for (const inline of inlines) {
    const last = merged[merged.length - 1]
    if (inline.kind === 'text' && last?.kind === 'text') last.text += inline.text
    else merged.push(inline)
  }
  return merged
}

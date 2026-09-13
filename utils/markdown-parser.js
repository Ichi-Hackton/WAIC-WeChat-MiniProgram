/**
 * 轻量 Markdown → rich-text nodes 解析器（Agent.md 4.2 节输出格式渲染）
 * 支持：# ~ #### 标题、**加粗**、`行内代码`、- / 1. 列表（一级嵌套）、
 *       > 引用块（观察记录"客观描述/专业分析"）、``` 代码块（沟通话术一键复制）、
 *       | 表格 |、--- 分割线、换行
 * 全部节点使用 inline style，不依赖外部 class，渲染稳定
 */

/* ---------- 行内解析：**加粗** 与 `行内代码` ---------- */
function parseInline(text) {
  const nodes = []
  // 先按 ** 分割：奇数段为加粗
  String(text).split('**').forEach((part, idx) => {
    const isBold = idx % 2 === 1
    // 段内再按 ` 分割：奇数段为行内代码
    part.split('`').forEach((cp, cidx) => {
      if (cp === '') return
      if (isBold) {
        nodes.push({ name: 'strong', children: [{ type: 'text', text: cp }] })
      } else if (cidx % 2 === 1) {
        nodes.push({
          name: 'span',
          attrs: {
            style: 'background:#FFF3E0;color:#C8721A;border-radius:6rpx;padding:0 8rpx;font-family:Consolas,monospace;font-size:0.9em;'
          },
          children: [{ type: 'text', text: cp }]
        })
      } else {
        nodes.push({ type: 'text', text: cp })
      }
    })
  })
  return nodes
}

/* ---------- 块级节点构造 ---------- */
const P_STYLE = 'margin:8rpx 0;white-space:pre-line;'
const QUOTE_P_STYLE = 'margin:4rpx 0;white-space:pre-line;'

function heading(level, text) {
  const sizes = ['40rpx', '36rpx', '32rpx', '30rpx']
  const lv = Math.min(level, 4)
  return {
    name: 'h' + lv,
    attrs: {
      style:
        'margin:' + (lv === 1 ? '24rpx' : '16rpx') + ' 0 8rpx;font-size:' + sizes[lv - 1] +
        ';color:#8C4A1B;font-weight:700;line-height:1.4;'
    },
    children: parseInline(text)
  }
}

function paragraph(text, style) {
  return { name: 'p', attrs: { style: style || P_STYLE }, children: parseInline(text) }
}

function quote(lines) {
  return {
    name: 'blockquote',
    attrs: {
      style:
        'margin:12rpx 0;padding:14rpx 20rpx;background:#FFF7E8;border-left:8rpx solid #FFB877;' +
        'border-radius:8rpx;color:#7A5A3A;'
    },
    children: lines.map((l) => paragraph(l, QUOTE_P_STYLE))
  }
}

function codeBlock(content) {
  return {
    name: 'pre',
    attrs: {
      style:
        'margin:12rpx 0;padding:20rpx 24rpx;background:#2B2B2B;border-radius:12rpx;' +
        'white-space:pre-wrap;word-break:break-all;overflow:hidden;'
    },
    children: [
      {
        name: 'code',
        attrs: {
          style: 'color:#F8F8F2;font-family:Consolas,"Courier New",monospace;font-size:26rpx;line-height:1.7;'
        },
        children: [{ type: 'text', text: content }]
      }
    ]
  }
}

function hrNode() {
  return { name: 'hr', attrs: { style: 'border:none;border-top:1rpx solid #EFE3D0;margin:16rpx 0;' } }
}

/** 列表块：items = [{ indent, ordered, text }]，支持一级嵌套 */
function listBlock(items) {
  const listStyle = 'margin:8rpx 0;padding-left:1.8em;'
  const liStyle = 'margin:4rpx 0;'
  const root = { name: items[0].ordered ? 'ol' : 'ul', attrs: { style: listStyle }, children: [] }
  let currentLi = null
  items.forEach((it) => {
    const li = { name: 'li', attrs: { style: liStyle }, children: parseInline(it.text) }
    if (it.indent >= 2 && currentLi) {
      // 嵌套项：挂到最近一个顶层 li 的子列表
      let sub = null
      for (const child of currentLi.children) {
        if (child.name === 'ul' || child.name === 'ol') { sub = child; break }
      }
      if (!sub) {
        sub = { name: 'ul', attrs: { style: listStyle }, children: [] }
        currentLi.children.push(sub)
      }
      sub.children.push(li)
    } else {
      root.children.push(li)
      currentLi = li
    }
  })
  return root
}

/** 表格：rows = ['| a | b |', '|---|---|', '| 1 | 2 |'] */
function tableBlock(rows) {
  const isDivider = (r) => /^\|?[\s:|-]+\|?$/.test(r) && r.indexOf('-') >= 0
  const parseCells = (r) =>
    r.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
  const trs = rows.filter((r) => !isDivider(r))
  if (!trs.length) return paragraph(rows.join(' '))
  const header = parseCells(trs[0])
  const body = trs.slice(1).map(parseCells)
  const cellStyle =
    'border:1rpx solid #F0E6D8;padding:8rpx 14rpx;font-size:26rpx;text-align:left;'
  const mkRow = (cells, isHeader) => ({
    name: 'tr',
    children: cells.map((c) => ({
      name: isHeader ? 'th' : 'td',
      attrs: { style: cellStyle + (isHeader ? 'background:#FFF7E8;color:#8C4A1B;' : '') },
      children: parseInline(c)
    }))
  })
  return {
    name: 'table',
    attrs: { style: 'border-collapse:collapse;margin:12rpx 0;width:100%;' },
    children: [
      { name: 'thead', children: [mkRow(header, true)] },
      { name: 'tbody', children: body.map((r) => mkRow(r, false)) }
    ]
  }
}

/* ---------- 主解析：逐行扫描分块 ---------- */
function parse(md) {
  const lines = String(md || '').split('\n')
  const nodes = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // 代码块 ```（可带语言标注）
    if (/^```/.test(line.trim())) {
      const buf = []
      i++
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i])
        i++
      }
      i++ // 跳过结束 ```
      nodes.push(codeBlock(buf.join('\n')))
      continue
    }

    // 表格行
    if (/^\s*\|.*\|/.test(line)) {
      const rows = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(lines[i].trim())
        i++
      }
      nodes.push(tableBlock(rows))
      continue
    }

    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      nodes.push(heading(h[1].length, h[2].trim()))
      i++
      continue
    }

    // 分割线
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      nodes.push(hrNode())
      i++
      continue
    }

    // 引用块 >
    if (/^\s*>\s?/.test(line)) {
      const buf = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      nodes.push(quote(buf))
      continue
    }

    // 列表项（无序 - * / 有序 1.）
    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/)
    if (li) {
      const items = []
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/)
        if (!m) break
        items.push({
          indent: Math.floor(m[1].replace(/\t/g, '  ').length / 2),
          ordered: /^\d+\./.test(m[2]),
          text: m[3]
        })
        i++
      }
      nodes.push(listBlock(items))
      continue
    }

    // 空行跳过
    if (line.trim() === '') {
      i++
      continue
    }

    // 普通段落
    nodes.push(paragraph(line.trim()))
    i++
  }
  return nodes
}

/** 提取全部代码块内容（供"复制话术"一键复制，Agent.md 4.2） */
function extractCodeBlocks(md) {
  const blocks = []
  const re = /```[^\n]*\n([\s\S]*?)```/g
  let m
  while ((m = re.exec(String(md || '')))) {
    const content = m[1].trim()
    if (content) blocks.push(content)
  }
  return blocks
}

module.exports = {
  parse,
  extractCodeBlocks
}

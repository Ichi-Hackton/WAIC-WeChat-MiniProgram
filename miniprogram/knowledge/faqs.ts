/**
 * 常見問題示例數據（對應 Agent.md 知識庫「常見問題／」目錄）。
 */

import type { FaqEntry } from './types';

const SRC = [{ name: 'MVP示例數據（待接入RAG知識庫：常見問題）', updatedAt: '2026年8月' }];

export const FAQS: FaqEntry[] = [
  {
    id: 'away-death',
    title: '在外地去世怎麼辦？',
    answer:
      '先在離世地就近醫院或公安機關開具死亡證明，然後二選一：①遺體運輸返鄉——由殯儀館專車跨市運輸，費用較高，先詢價再確認；②就地火化後攜帶骨灰返鄉——費用更低，辦理更簡便。後續行政手續（戶籍、社保）仍在戶籍地／參保地辦理。',
    sources: SRC,
  },
  {
    id: 'minority-funeral',
    title: '少數民族殯葬有什麼不同？',
    answer:
      '少數民族可按政策選擇符合本民族習俗的安葬方式（部分地區可實行土葬）；宗教儀軌建議提前與殯儀館確認，多數場館可以協調。具體政策以當地民政部門規定為準。',
    sources: SRC,
  },
  {
    id: 'no-kin',
    title: '沒有親屬或親屬無力處理怎麼辦？',
    answer:
      '可聯繫逝者生前所在單位、社區居委會（村委會）或當地民政部門，由其協助或依規處理；產生的基本殯葬費用按當地規定從遺產或補助中優先支付。',
    sources: SRC,
  },
];

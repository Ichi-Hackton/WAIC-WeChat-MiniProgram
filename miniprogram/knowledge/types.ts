/**
 * 知識庫類型定義。
 *
 * 數據結構對齊 Agent.md 的 RAG 知識庫目錄：
 * - procedures   → 流程指引／（死亡證明開具、殯儀館流程、戶籍註銷、社保結算、公積金提取、喪葬補貼申領、遺產處理…）
 * - cityPolicies → 地區政策／（北京、上海、廣州、杭州…）
 * - fees         → 費用參考／（殯儀館收費標準、喪葬補助金標準、殯葬用品價格區間）
 * - faqs         → 常見問題／（在外地去世怎麼辦、少數民族殯葬、無親屬處理）
 * - templates    → 話術模板／（哀悼語、敏感場景應對、免責聲明）
 *
 * MVP 階段為本地示例數據；後續接入 RAG 時僅替換 services/knowledge.ts 的
 * 實現（改為雲函數／遠端檢索），本文件與頁面調用方式不變。
 */

export interface KnowledgeSource {
  /** 來源名稱（MVP 階段標註為示例數據） */
  name: string;
  /** 更新時間，如「2026年8月」 */
  updatedAt: string;
}

export interface Hotline {
  label: string;
  number: string;
}

/** 流程指引：對應 Agent.md「流程四：單項深挖」的展開內容 */
export interface ProcedureDetail {
  id: string;
  title: string;
  summary: string;
  where: string;
  materials: string[];
  deadline: string;
  cautions: string[];
  fees: { label: string; range: string }[];
  faqs: { q: string; a: string }[];
  contact: Hotline;
  sources: KnowledgeSource[];
}

/** 費用參考：對應 Agent.md「流程三：費用查詢」 */
export interface FeeReference {
  city: string;
  baseServices: { name: string; price: string }[];
  supplies: { name: string; range: string }[];
  subsidyNote: string;
  traps: string[];
  sources: KnowledgeSource[];
}

/** 地區政策：城市級的聯辦入口與差異提示 */
export interface CityPolicy {
  city: string;
  oneStop: boolean;
  oneStopChannel: string;
  summary: string;
  notes: string[];
  hotlines: Hotline[];
  sources: KnowledgeSource[];
}

/** 常見問題 */
export interface FaqEntry {
  id: string;
  title: string;
  answer: string;
  sources: KnowledgeSource[];
}

/**
 * 個性化辦理清單生成器（純函數內核，永不 import wx）
 *
 * 依據 Agent.md「流程二：生成個性化辦理清單」：
 * - 分時段：第一天（今天）／第2-3天（殯儀安排）／第4-7天（行政手續）／後續（財產與紀念）；
 * - 每項包含：做什麼、去哪裡、帶什麼、注意什麼（⚠️）、預計費用；
 * - 根據離世地點、社保情況、宗教／民族背景動態調整任務。
 */

import type { GuideProfile } from './guidance-flow';

export type StageId = 0 | 1 | 2 | 3;

export interface ChecklistTask {
  id: string;
  stage: StageId;
  title: string;
  where?: string;
  materials?: string[];
  deadline?: string;
  note?: string;
  fee?: string;
  detailId?: string;
}

/** 清單的用戶狀態：勾選、認領人、自定義追加事項（由 services/storage 持久化） */
export interface ChecklistState {
  done: Record<string, boolean>;
  claimers: Record<string, string>;
  customItems: ChecklistTask[];
}

export interface GeneratedChecklist {
  generatedAt: string;
  profile: GuideProfile;
  tasks: ChecklistTask[];
}

export const STAGE_DEFS: { id: StageId; title: string }[] = [
  { id: 0, title: '第一天（今天）｜立即要辦' },
  { id: 1, title: '第2-3天｜殯儀安排' },
  { id: 2, title: '第4-7天｜行政手續' },
  { id: 3, title: '後續｜財產與紀念' },
];

export function emptyChecklistState(): ChecklistState {
  return { done: {}, claimers: {}, customItems: [] };
}

/** 第一步：死亡證明。開具途徑因離世地點而異（Agent.md 全流程的起點） */
function deathCertTask(profile: GuideProfile): ChecklistTask {
  const base: ChecklistTask = {
    id: 'death-cert',
    stage: 0,
    title: '開具《死亡醫學證明》',
    materials: ['逝者身份證', '經辦家屬身份證'],
    deadline: '醫院離世：辦理離院手續前；建議開具後複印3-4份備用',
    note: '⚠️ 必須加蓋簽發單位公章；後續的火化、戶籍註銷、社保結算都以它為依據。',
    detailId: 'death-cert',
  };
  switch (profile.place) {
    case 'home':
      return {
        ...base,
        title: '聯繫社區與派出所，開具死亡證明',
        where: '所在地社區衛生服務中心／轄區派出所',
        note:
          '⚠️ 家中離世一般需社區醫生或民警到場確認後開具；若屬非正常死亡，必須由公安部門處理。證明須加蓋公章，並複印3-4份備用。',
      };
    case 'care-home':
      return {
        ...base,
        title: '請機構協助開具死亡證明',
        where: '養老機構醫務室（協助聯繫就診醫院或社區醫生）',
        note: '⚠️ 先與機構值班負責人確認證明開具途徑；證明須加蓋公章，並複印3-4份備用。',
      };
    case 'away':
      return {
        ...base,
        title: '在外地開具死亡證明',
        where: '離世地就近醫院或公安機關',
        note:
          '⚠️ 在外地離世：先就地開具死亡證明，再決定「遺體運輸返鄉」或「就地火化後攜骨灰返鄉」（後者費用更低）。證明須加蓋公章，並複印3-4份備用。',
      };
    case 'hospital':
    default:
      return {
        ...base,
        where: '逝者離世的醫院（醫務科／住院部服務台）',
      };
  }
}

/** 根據檔案生成分時段清單（順序即展示順序） */
export function generateChecklist(profile: GuideProfile): GeneratedChecklist {
  const tasks: ChecklistTask[] = [];
  const isChild = profile.relation === 'child';

  // ---------- 第一天（今天）｜立即要辦 ----------
  tasks.push(deathCertTask(profile));

  if (profile.place === 'away') {
    tasks.push({
      id: 'body-transport',
      stage: 0,
      title: '與兩地殯儀館確認遺體運輸方案',
      where: '離世地殯儀館（承運）＋ 辦理城市殯儀館（接收）',
      materials: ['死亡證明', '經辦人身份證'],
      note: '⚠️ 遺體原則上由殯儀館專車跨市運輸，費用較高；先問清全部費用再確認，也可選擇就地火化後攜骨灰返鄉。',
      fee: '跨市運輸按公里計費，以兩地殯儀館報價為準',
      detailId: 'funeral',
    });
  }

  tasks.push({
    id: 'funeral-contact',
    stage: 0,
    title: '聯繫殯儀館，安排遺體接運',
    where: '辦理城市殯儀館服務熱線（可撥打12345查詢）',
    materials: ['死亡證明', '經辦人身份證'],
    deadline: '死亡證明開具後盡快（一般24小時內）',
    note: '⚠️ 先問清所有費用明細再確認；「加急費」「選號費」「開光費」均為非必要收費，可以拒絕。',
    fee: '遺體接運約200-400元（政府定價，按距離）',
    detailId: 'funeral',
  });

  tasks.push({
    id: 'notify-family',
    stage: 0,
    title: '通知至親好友，安排家屬分工',
    note: isChild
      ? '此刻不必急著通知太多人，以您和家人的狀態為先。可以把清單分享到家庭群，讓家人認領事項、分工處理。'
      : '建議由一位家屬牽頭，把清單分享到家庭群，讓家人認領事項、分工處理，不必一個人扛下所有事。',
  });

  // ---------- 第2-3天｜殯儀安排 ----------
  tasks.push({
    id: 'farewell',
    stage: 1,
    title: '確定告別儀式的時間與形式',
    where: '殯儀館告別廳（預約時說明需求）',
    note: '⚠️ 廳型、鮮花、佈置的價差很大；先問清政府定價部分與市場價部分，按需選擇，不必接受推銷。',
    fee: '基礎告別廳數百元起，佈置另計',
    detailId: 'funeral',
  });

  if (profile.religion === 'ethnic-minority' || profile.religion === 'religious') {
    tasks.push({
      id: 'religion-arrange',
      stage: 1,
      title: '與殯儀館確認宗教／民族儀軌安排',
      note: '⚠️ 少數民族可按政策選擇符合習俗的安葬方式；宗教儀軌細節建議同時請教相關人士，預約時提前說明。',
      detailId: 'funeral',
    });
  }

  tasks.push({
    id: 'cremation',
    stage: 1,
    title: '辦理火化，領取火化證明',
    where: '殯儀館火化間（辦事窗口）',
    materials: ['死亡證明原件', '經辦人身份證', '繳費憑證'],
    note: '⚠️ 火化證明是註銷戶籍、申領補助的關鍵材料，請與死亡證明分開妥善保管。',
    fee: '火化約400-600元（政府定價）',
    detailId: 'funeral',
  });

  tasks.push({
    id: 'ashes',
    stage: 1,
    title: '安排骨灰安置（暫存或墓地）',
    note: '⚠️ 骨灰盒可自行選購；個別殯儀館稱「不能自帶骨灰盒」屬不合理條款，可先確認或向民政部門反映。不必急於決定墓地，可先暫存。',
    fee: '基礎骨灰盒約200-500元；骨灰暫存每年數十至數百元',
    detailId: 'funeral',
  });

  // ---------- 第4-7天｜行政手續 ----------
  tasks.push({
    id: 'household-cancel',
    stage: 2,
    title: '前往派出所註銷戶籍',
    where: '逝者戶籍所在地派出所（部分城市可在「身後一件事」窗口聯辦）',
    materials: ['死亡證明', '火化證明', '經辦人身份證', '逝者戶口本'],
    deadline: '一般要求30天內辦理（以當地規定為準）',
    note: '⚠️ 註銷前先複印戶口頁留檔，後續辦理繼承時可能需要。',
    detailId: 'household',
  });

  if (profile.socialSecurity === 'insured') {
    tasks.push({
      id: 'social-security',
      stage: 2,
      title: '辦理社保結算與喪葬補助金、撫恤金申領',
      where: '當地社保經辦機構或政務服務大廳（支持聯辦的城市可一併辦理）',
      materials: ['死亡證明', '火化證明', '經辦人身份證', '與逝者關係證明', '經辦人銀行卡'],
      deadline: '補助申領有時限，建議1個月內諮詢辦理（以當地規定為準）',
      note: '⚠️ 配偶離世可一併諮詢遺屬待遇；醫保個人賬戶餘額可依法繼承，別忘了結清。',
      fee: '申領不收費；補助一般為當地上年度社平工資的2-4個月',
      detailId: 'social',
    });
  } else {
    tasks.push({
      id: 'ss-verify',
      stage: 2,
      title: '先確認逝者社保狀態',
      where: '撥打12333，或在政務App／小程序查詢參保記錄',
      note: '⚠️ 確認是否參加過城鎮職工或城鄉居民養老保險、在哪裡參保，再決定後續結算與補助申領。',
      detailId: 'subsidy',
    });
    tasks.push({
      id: 'subsidy-apply',
      stage: 2,
      title: '諮詢並申領喪葬補助（含城鄉居民）',
      where: '當地社保經辦機構（熱線12333）',
      materials: ['死亡證明', '火化證明', '經辦人身份證', '與逝者關係證明', '經辦人銀行卡'],
      note: '⚠️ 參加城鄉居民養老保險的逝者也有喪葬補助，標準由各地確定；以社保經辦機構核定為準。',
      detailId: 'subsidy',
    });
  }

  // ---------- 後續｜財產與紀念 ----------
  tasks.push({
    id: 'provident-fund',
    stage: 3,
    title: '提取住房公積金餘額',
    where: '當地公積金中心（熱線12329）',
    materials: ['死亡證明', '經辦人身份證', '親屬關係證明或繼承文書', '經辦人銀行卡'],
    note: '部分城市支持線上申請，可先電話確認材料清單再前往。',
    detailId: 'provident',
  });

  tasks.push({
    id: 'bank-estate',
    stage: 3,
    title: '梳理並繼承銀行存款、房產等遺產',
    where: '各銀行網點、不動產登記中心、公證處',
    materials: ['死亡證明', '親屬關係證明', '繼承公證文書或生效法律文書（視機構要求）', '經辦人身份證'],
    note: '⚠️ 各銀行對小額存款簡化支取的額度不同，先電話確認；房產繼承建議家庭先協商一致，有爭議時尋求調解或法律幫助。',
    detailId: 'estate',
  });

  tasks.push({
    id: 'insurance-claim',
    stage: 3,
    title: '排查逝者名下保單並申請理賠',
    note: '壽險、意外險、年金險等均可由受益人申請理賠；可從逝者手機短信、銀行扣費記錄、郵箱入手排查。',
    detailId: 'estate',
  });

  tasks.push({
    id: 'phone-accounts',
    stage: 3,
    title: '處理手機號與社交賬號',
    where: '運營商營業廳、各社交平台官方渠道',
    note: '手機號註銷前，先導出照片、通訊錄與重要聊天記錄留作紀念；各平台「逝者賬號」政策不同，可在幫助中心搜索「親屬去世」。',
    detailId: 'other-accounts',
  });

  return {
    generatedAt: new Date().toISOString(),
    profile,
    tasks,
  };
}

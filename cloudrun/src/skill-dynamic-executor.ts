/**
 * 動態技能統一執行器 — http / mcp / llm 三路（L2）
 *
 * 職責邊界：
 *   - 入參以技能 inputSchema 重新校驗（run 每次重新驗證，不信任客戶端）
 *   - http / mcp 僅能引用服務端預註冊連接器（connectors 層治理 SSRF / 唯讀）
 *   - llm 為「無工具純文本」執行：System Prompt 禁止要求即時外部數據，
 *     輸出標記 ai_generated（合規紅線：生成內容必須標識）
 *   - 冪等一律 false：與 adapter 快取語義對齊（永不用快取回應動態技能）
 *
 * 可測試性：三個外部依賴（httpGet / mcpCall / llmChat）經 configureExecutorDeps
 * 注入替代實現（node --test 免起真實上游）；resetExecutorDeps 恢復預設。
 *
 * 配額：每 openid 每小時 DYNAMIC_SKILL_RUN_QUOTA 次（默認 30；進程內計數，
 * 重啟歸零——動態技能為輔助能力，進程級限流足夠）。
 */

import type { RequestContext } from './api';
import { handleChat } from './llm-chat';
import { callMcpTool, McpToolError } from './mcp-client';
import {
  assertMcpEndpointAllowed,
  getConnector,
  httpGetSafe,
  HttpFetchError,
  resolveFieldPath,
  type HttpConnectorConfig,
} from './skill-dynamic-connectors';
import { validateInputAgainstSchema } from './skill-dynamic-schema';
import type { DynamicRunData, DynamicSkillRecord } from './skill-dynamic-types';

/** 業務失敗（路由層翻譯為 fail(200, code, message)；code 為穩定業務碼） */
export class DynamicRunError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DynamicRunError';
    this.code = code;
  }
}

/** 執行器外部依賴（測試注入點） */
export interface ExecutorDeps {
  httpGet: (conn: HttpConnectorConfig, params: Record<string, string | number | boolean>) => Promise<{ status: number; json: unknown }>;
  mcpCall: (endpoint: string, tool: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<string>;
  llmChat: (messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, opts?: { temperature?: number; maxTokens?: number; jsonMode?: boolean }) => Promise<{ text: string }>;
}

/** 內部直呼 llm-chat（避免 HTTP 自轉發；與 counseling 直呼 handleChat 同款先例） */
async function defaultLlmChat(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts?: { temperature?: number; maxTokens?: number; jsonMode?: boolean },
): Promise<{ text: string }> {
  const result = await handleChat(
    { messages, temperature: opts?.temperature, maxTokens: opts?.maxTokens, jsonMode: opts?.jsonMode },
    { openid: 'system.dynamic', sessionId: 'system.dynamic' },
  );
  if (result.body.code !== 0 || !result.body.data || typeof result.body.data !== 'object') {
    throw new DynamicRunError('llm_unavailable', '文本生成服務暫不可用');
  }
  const data = result.body.data as { text?: unknown };
  if (typeof data.text !== 'string') throw new DynamicRunError('llm_unavailable', '文本生成服務回應異常');
  return { text: data.text };
}

/** 當前依賴（預設接真實上游） */
let deps: ExecutorDeps = {
  httpGet: httpGetSafe,
  mcpCall: callMcpTool,
  llmChat: defaultLlmChat,
};

/** 注入測試替身（部分覆蓋；未覆蓋項維持現值） */
export function configureExecutorDeps(partial: Partial<ExecutorDeps>): void {
  deps = { ...deps, ...partial };
}

/** 恢復預設依賴（測試收尾用） */
export function resetExecutorDeps(): void {
  deps = { httpGet: httpGetSafe, mcpCall: callMcpTool, llmChat: defaultLlmChat };
}

/** 取當前 llmChat 依賴（forge 與執行器共用同一注入點，測試一次配置雙處生效） */
export function getLlmChatDep(): ExecutorDeps['llmChat'] {
  return deps.llmChat;
}

// ---- 配額（進程內滑動窗口） ----

/** openid → 最近一小時內的執行時間戳 */
const runWindow = new Map<string, number[]>();

/** 清理過期窗口並檢查配額；超限拋 quota_exceeded */
export function checkRunQuota(openid: string): void {
  const quota = Math.max(1, Number(process.env.DYNAMIC_SKILL_RUN_QUOTA ?? 30) || 30);
  const now = Date.now();
  const window = (runWindow.get(openid) ?? []).filter((t) => now - t < 3_600_000);
  if (window.length >= quota) {
    runWindow.set(openid, window);
    throw new DynamicRunError('quota_exceeded', `動態技能執行已達每小時上限（${quota} 次）`);
  }
  window.push(now);
  runWindow.set(openid, window);
}

// ---- 輸出封裝 ----

/** 輸出正文上限（字元） */
const MAX_TEXT = 4000;
/** 單行展示值上限（字元） */
const MAX_LINE_VALUE = 160;

/** 由 outFields 渲染受控展示行（取不到的欄位以「—」佔位） */
function renderLines(
  json: unknown,
  outFields: Array<{ key: string; label: string }>,
): Array<{ label: string; value: string }> {
  return outFields.map((f) => ({
    label: f.label,
    value: (resolveFieldPath(json, f.key) ?? '—').slice(0, MAX_LINE_VALUE),
  }));
}

/** 入參純量表 → 展示行（llm 類用；label 取屬性名） */
function inputLines(input: Record<string, unknown>): Array<{ label: string; value: string }> {
  return Object.entries(input)
    .filter(([, v]) => v !== undefined && v !== null)
    .slice(0, 6)
    .map(([k, v]) => ({ label: k, value: String(v).slice(0, MAX_LINE_VALUE) }));
}

/** 統一結果封裝（text 截斷；http/mcp 的 text 由行拼接） */
function buildRunData(
  title: string,
  text: string,
  lines: Array<{ label: string; value: string }>,
  aiGenerated: boolean,
): DynamicRunData {
  return {
    output: { text: text.slice(0, MAX_TEXT) },
    display: {
      title: title.slice(0, 40),
      lines: lines.slice(0, 6).map((l) => ({ label: l.label.slice(0, 12), value: l.value.slice(0, MAX_LINE_VALUE) })),
    },
    ai_generated: aiGenerated,
  };
}

/** HttpFetchError → 穩定業務碼（SSRF 阻斷單獨歸類，便於審計） */
function mapHttpError(e: HttpFetchError): DynamicRunError {
  switch (e.kind) {
    case 'private_address':
      return new DynamicRunError('ssrf_blocked', e.message);
    case 'redirect':
      return new DynamicRunError('upstream_redirect', e.message);
    case 'timeout':
      return new DynamicRunError('upstream_timeout', e.message);
    case 'invalid_url':
      return new DynamicRunError('connector_invalid', e.message);
    default:
      return new DynamicRunError('upstream_failed', `上游請求失敗${e.status ? `（HTTP ${e.status}）` : ''}：${e.message}`);
  }
}

/**
 * 執行一筆動態技能（統一入口）
 *
 * 前置（順序不可調換）：
 *   1. 狀態必為 approved（縱深防禦；路由層已驗，此處複核）
 *   2. 入參依 inputSchema 重新校驗
 *   3. http / mcp：連接器必須存在且 kind 相符
 */
export async function runDynamic(
  record: DynamicSkillRecord,
  input: unknown,
  _ctx: RequestContext,
): Promise<DynamicRunData> {
  if (record.status !== 'approved') {
    throw new DynamicRunError('skill_not_active', '該技能未處於已上架狀態');
  }
  const check = validateInputAgainstSchema(input, record.definition.inputSchema);
  if (!check.ok) throw new DynamicRunError('invalid_input', check.error ?? '入參不合法');
  const params = input as Record<string, string | number | boolean>;

  switch (record.definition.kind) {
    case 'http': {
      const conn = getConnector(record.definition.connectorId ?? '');
      if (!conn || conn.kind !== 'http') {
        throw new DynamicRunError('connector_missing', '該技能引用的連接器已下線，請聯繫管理員');
      }
      let result: { status: number; json: unknown };
      try {
        result = await deps.httpGet(conn, params);
      } catch (e) {
        if (e instanceof HttpFetchError) throw mapHttpError(e);
        throw new DynamicRunError('upstream_failed', `上游請求失敗：${e instanceof Error ? e.message : String(e)}`);
      }
      const lines = renderLines(result.json, conn.outFields);
      const text = lines.map((l) => `${l.label}：${l.value}`).join('\n');
      return buildRunData(record.name, text, lines, false);
    }
    case 'mcp': {
      const conn = getConnector(record.definition.connectorId ?? '');
      if (!conn || conn.kind !== 'mcp') {
        throw new DynamicRunError('connector_missing', '該技能引用的連接器已下線，請聯繫管理員');
      }
      let raw: string;
      try {
        await assertMcpEndpointAllowed(conn); // 私網 / 公網位址治理（連接器層）
        raw = await deps.mcpCall(conn.url, conn.tool, params, 20_000);
      } catch (e) {
        if (e instanceof HttpFetchError) throw mapHttpError(e);
        if (e instanceof McpToolError) throw new DynamicRunError('mcp_tool_failed', `工具執行失敗：${e.message}`);
        throw new DynamicRunError('mcp_unreachable', 'MCP 服務暫不可用，請稍後再試');
      }
      let json: unknown;
      try {
        json = JSON.parse(raw) as unknown;
      } catch {
        json = { text: raw.slice(0, 2000) };
      }
      const lines = renderLines(json, conn.outFields);
      const text = lines.map((l) => `${l.label}：${l.value}`).join('\n');
      return buildRunData(record.name, text, lines, false);
    }
    case 'llm': {
      const instructions = record.definition.instructions ?? '';
      // 合規紅線：LLM 生成內容必須標識（ai_generated: true）；
      // 防幻覺：無工具情況下禁止編造即時數據（forge 期已攔截即時類需求）
      const system = [
        instructions,
        '',
        '【安全約束】',
        '- 你沒有任何查詢工具，不得聲稱或編造任何即時數據（股價、天氣、餘票等）。',
        '- 僅基於輸入參數與通用知識作答；需要即時數據時明確說明無法提供。',
        '- 以純文字回答，不輸出 JSON / Markdown 代碼塊。',
        '- 不主動詢問或複述用戶的個人敏感信息。',
      ].join('\n');
      const user = Object.keys(params).length > 0
        ? `輸入參數：${JSON.stringify(params)}\n\n請依技能說明處理。`
        : '請依技能說明處理。';
      let result: { text: string };
      try {
        result = await deps.llmChat(
          [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          { temperature: 0.4, maxTokens: 800 },
        );
      } catch (e) {
        if (e instanceof DynamicRunError) throw e;
        throw new DynamicRunError('llm_unavailable', '文本生成服務暫不可用');
      }
      const text = result.text.trim();
      if (!text) throw new DynamicRunError('llm_empty', '生成結果為空，請重試');
      return buildRunData(record.name, text, inputLines(params), true);
    }
  }
}

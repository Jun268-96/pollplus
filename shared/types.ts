// PollPlus 공용 프로토콜 타입 — 프론트(src/)와 워커(worker/) 양쪽에서 import한다.
// DOM/Workers 전용 전역 타입에 의존하지 않는 순수 TS 타입만 둔다.

export type QuestionType = 'multiple_choice' | 'open_text' | 'word_cloud' | 'quiz';

export interface QuestionOption {
  id: string;
  text: string;
}

interface QuestionCommon {
  id: string;
  prompt: string;
  position: number;
  /** 이 문항이 지금 새 응답을 받는가 (accepting/results_visible 축 참고: 계획서 "문항 상태: 3개의 독립 축") */
  accepting: boolean;
  /** TV(viewer)에 집계를 공개했는가 — blind 토글 */
  resultsVisible: boolean;
}

/** 관리자(admin)만 보는 전체 문항 — 퀴즈 정답 포함 */
export type AdminQuestion =
  | (QuestionCommon & { type: 'multiple_choice'; options: QuestionOption[] })
  | (QuestionCommon & { type: 'open_text' })
  | (QuestionCommon & { type: 'word_cloud' })
  | (QuestionCommon & { type: 'quiz'; options: QuestionOption[]; correctOptionId: string });

/** participant/viewer에게 나가는 문항 — 퀴즈 정답(correctOptionId)은 제외 */
export type PublicQuestion =
  | (QuestionCommon & { type: 'multiple_choice'; options: QuestionOption[] })
  | (QuestionCommon & { type: 'open_text' })
  | (QuestionCommon & { type: 'word_cloud' })
  | (QuestionCommon & { type: 'quiz'; options: QuestionOption[] });

export function toPublicQuestion(q: AdminQuestion): PublicQuestion {
  if (q.type === 'quiz') {
    const { correctOptionId: _correctOptionId, ...rest } = q;
    return rest;
  }
  return q;
}

export function isChoiceType(type: QuestionType): type is 'multiple_choice' | 'quiz' {
  return type === 'multiple_choice' || type === 'quiz';
}

// ---------------------------------------------------------------------------
// 응답 payload
// ---------------------------------------------------------------------------

export type ResponsePayload =
  | { kind: 'choice'; optionId: string }
  | { kind: 'text'; text: string };

export interface ResponseItem {
  id: string;
  text: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// 집계(results) — role에 따라 다른 payload가 나갈 수 있음 (hidden = blind 상태)
// ---------------------------------------------------------------------------

export type Aggregate =
  | { type: 'multiple_choice'; total: number; counts: Record<string, number> }
  | { type: 'quiz'; total: number; counts: Record<string, number>; correctOptionId: string }
  | { type: 'open_text'; items: ResponseItem[] }
  | { type: 'word_cloud'; words: { text: string; count: number }[]; items: ResponseItem[] }
  | { type: 'hidden'; total: number };

// ---------------------------------------------------------------------------
// 문항 CRUD 입력
// ---------------------------------------------------------------------------

export interface NewQuestionInput {
  type: QuestionType;
  prompt: string;
  options?: QuestionOption[]; // multiple_choice / quiz
  correctOptionId?: string; // quiz
}

export type QuestionPatch = Partial<{
  prompt: string;
  options: QuestionOption[];
  correctOptionId: string;
}>;

// ---------------------------------------------------------------------------
// WS 역할
// ---------------------------------------------------------------------------

export type Role = 'admin' | 'participant' | 'viewer';

// ---------------------------------------------------------------------------
// 클라이언트 → 서버
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'add_question'; input: NewQuestionInput }
  | { type: 'update_question'; questionId: string; patch: QuestionPatch }
  | { type: 'delete_question'; questionId: string }
  | { type: 'reorder_questions'; questionIds: string[] }
  | { type: 'set_active'; questionId: string | null }
  | { type: 'set_accepting'; questionId: string; accepting: boolean }
  | { type: 'set_results_visible'; questionId: string; visible: boolean }
  | { type: 'hide_response'; responseId: string }
  | { type: 'submit'; questionId: string; payload: ResponsePayload };

// ---------------------------------------------------------------------------
// 서버 → 클라이언트
// ---------------------------------------------------------------------------

/** admin: 접속 시 1회 + 문항 구조가 바뀔 때마다(add/update/delete/reorder/active/accepting/visible) 전체 재전송.
 *  "무캐싱 거울" 원칙 — 클라이언트는 patch하지 않고 통째로 교체한다. */
export interface AdminStateMessage {
  type: 'state';
  role: 'admin';
  poll: { id: string; title: string; createdAt: number };
  questions: AdminQuestion[];
  activeQuestionId: string | null;
}

/** participant/viewer: 접속 시 1회 + 활성 문항이 바뀔 때마다 전체 재전송.
 *  다른 문항의 존재 자체를 알리지 않음(향후 퀴즈 스포일러 방지 포함). */
export interface PublicStateMessage {
  type: 'state';
  role: 'participant' | 'viewer';
  poll: { id: string; title: string; createdAt: number };
  activeQuestion: PublicQuestion | null;
}

export type StateMessage = AdminStateMessage | PublicStateMessage;

export type ServerMessage =
  | StateMessage
  | { type: 'results'; questionId: string; aggregate: Aggregate }
  | { type: 'presence'; participantCount: number }
  | {
      type: 'submit_ack';
      questionId: string;
      ok: boolean;
      reason?: 'not_active' | 'not_accepting' | 'duplicate' | 'invalid';
      quiz?: { correct: boolean; correctOptionId: string };
    }
  | { type: 'error'; reason: string };

// ---------------------------------------------------------------------------
// REST (poll 생성)
// ---------------------------------------------------------------------------

export interface CreatePollRequest {
  title: string;
}

export interface CreatePollResponse {
  pollId: string;
  adminKey: string;
}

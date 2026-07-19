import { DurableObject } from 'cloudflare:workers';
import type {
  AdminQuestion,
  ClientMessage,
  NewQuestionInput,
  QuestionOption,
  QuestionPatch,
  Aggregate,
  ResponseItem,
  ResponsePayload,
  Role,
  ServerMessage,
  PublicStateMessage,
  ViewerAggregate,
} from '../shared/types';
import { toPublicQuestion } from '../shared/types';
import type { Env } from './env';

// ---------------------------------------------------------------------------
// DB row shapes (SqlStorage만 다루는 내부 타입 — SqlStorageValue엔 boolean이 없어
// accepting/results_visible/hidden은 0/1 정수로 저장한다)
// ---------------------------------------------------------------------------

interface PollRow {
  [key: string]: SqlStorageValue;
  id: string;
  title: string;
  admin_key: string;
  active_question_id: string | null;
  created_at: number;
}

interface QuestionRow {
  [key: string]: SqlStorageValue;
  id: string;
  type: string;
  prompt: string;
  options: string | null;
  correct_option_id: string | null;
  position: number;
  accepting: number;
  results_visible: number;
}

interface ResponseRow {
  [key: string]: SqlStorageValue;
  id: string;
  question_id: string;
  socket_tag: string;
  payload: string;
  hidden: number;
  created_at: number;
}

interface IdRow {
  [key: string]: SqlStorageValue;
  id: string;
}

interface MaxPositionRow {
  [key: string]: SqlStorageValue;
  maxPos: number | null;
}

interface QuestionIdRow {
  [key: string]: SqlStorageValue;
  question_id: string;
}

/** WebSocket 연결(소켓)마다 serializeAttachment로 저장하는 메타데이터.
 *  참여자 쪽엔 아무것도 저장하지 않는 대신(계획서 "참여자 클라이언트 = 무캐싱 거울"),
 *  중복 제출 방지는 서버가 이 연결 자체에 붙여서 관리한다. */
interface SocketAttachment {
  role: Role;
  socketTag: string;
  answered: Record<string, boolean>;
}

const MAX_QUESTIONS = 100;
const MAX_ID_LENGTH = 128;
const MAX_PROMPT_LENGTH = 1_000;
const MAX_OPTION_TEXT_LENGTH = 200;
const MAX_OPTIONS = 10;
const MAX_RESPONSE_TEXT_LENGTH = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function isText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isOptions(value: unknown): value is QuestionOption[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.length <= MAX_OPTIONS &&
    value.every((option) => isRecord(option) && isId(option.id) && isText(option.text, MAX_OPTION_TEXT_LENGTH)) &&
    new Set(value.map((option) => option.id)).size === value.length
  );
}

/** TypeScript 타입은 네트워크 입력을 검증하지 않는다. 모든 WS 메시지는 여기서 좁힌다. */
function parseClientMessage(value: unknown): ClientMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;

  switch (value.type) {
    case 'submit': {
      if (!isId(value.questionId) || !isRecord(value.payload)) return null;
      if (value.payload.kind === 'choice' && isId(value.payload.optionId)) {
        return { type: 'submit', questionId: value.questionId, payload: { kind: 'choice', optionId: value.payload.optionId } };
      }
      if (value.payload.kind === 'text' && isText(value.payload.text, MAX_RESPONSE_TEXT_LENGTH)) {
        return { type: 'submit', questionId: value.questionId, payload: { kind: 'text', text: value.payload.text.trim() } };
      }
      return null;
    }
    case 'add_question': {
      if (!isRecord(value.input)) return null;
      const input = value.input;
      if (!isText(input.prompt, MAX_PROMPT_LENGTH)) return null;
      const { type, prompt } = input;
      if (type === 'open_text' || type === 'word_cloud') return { type: 'add_question', input: { type, prompt: prompt.trim() } };
      if ((type === 'multiple_choice' || type === 'quiz') && isOptions(input.options)) {
        if (type === 'quiz' && (!isId(input.correctOptionId) || !input.options.some((o) => o.id === input.correctOptionId))) return null;
        return {
          type: 'add_question',
          input: {
            type,
            prompt: prompt.trim(),
            options: input.options,
            ...(type === 'quiz' ? { correctOptionId: input.correctOptionId as string } : {}),
          },
        };
      }
      return null;
    }
    case 'update_question': {
      if (!isId(value.questionId) || !isRecord(value.patch)) return null;
      const patch: QuestionPatch = {};
      if ('prompt' in value.patch) {
        if (!isText(value.patch.prompt, MAX_PROMPT_LENGTH)) return null;
        patch.prompt = value.patch.prompt.trim();
      }
      if ('options' in value.patch) {
        if (!isOptions(value.patch.options)) return null;
        patch.options = value.patch.options;
      }
      if ('correctOptionId' in value.patch) {
        if (!isId(value.patch.correctOptionId)) return null;
        patch.correctOptionId = value.patch.correctOptionId;
      }
      if (Object.keys(patch).length === 0) return null;
      return { type: 'update_question', questionId: value.questionId, patch };
    }
    case 'delete_question':
    case 'hide_response':
      return isId(value[value.type === 'delete_question' ? 'questionId' : 'responseId'])
        ? (value.type === 'delete_question'
          ? { type: 'delete_question', questionId: value.questionId as string }
          : { type: 'hide_response', responseId: value.responseId as string })
        : null;
    case 'reorder_questions':
      return Array.isArray(value.questionIds) && value.questionIds.length <= MAX_QUESTIONS && value.questionIds.every(isId)
        ? { type: 'reorder_questions', questionIds: value.questionIds }
        : null;
    case 'set_active':
      return value.questionId === null || isId(value.questionId) ? { type: 'set_active', questionId: value.questionId } : null;
    case 'set_accepting':
      return isId(value.questionId) && typeof value.accepting === 'boolean'
        ? { type: 'set_accepting', questionId: value.questionId, accepting: value.accepting }
        : null;
    case 'set_results_visible':
      return isId(value.questionId) && typeof value.visible === 'boolean'
        ? { type: 'set_results_visible', questionId: value.questionId, visible: value.visible }
        : null;
    default:
      return null;
  }
}

export class PollRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS poll (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          admin_key TEXT NOT NULL,
          active_question_id TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS questions (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          prompt TEXT NOT NULL,
          options TEXT,
          correct_option_id TEXT,
          position INTEGER NOT NULL,
          accepting INTEGER NOT NULL DEFAULT 0,
          results_visible INTEGER NOT NULL DEFAULT 1
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS responses (
          id TEXT PRIMARY KEY,
          question_id TEXT NOT NULL,
          socket_tag TEXT NOT NULL,
          payload TEXT NOT NULL,
          hidden INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        )
      `);
    });
  }

  // ---------------------------------------------------------------------
  // RPC: Worker가 poll 생성 직후 1회 호출 (idempotent)
  // ---------------------------------------------------------------------

  async initPoll(pollId: string, title: string, adminKey: string): Promise<void> {
    const existing = this.ctx.storage.sql.exec<IdRow>('SELECT id FROM poll LIMIT 1').toArray();
    if (existing.length > 0) return;
    this.ctx.storage.sql.exec(
      'INSERT INTO poll (id, title, admin_key, active_question_id, created_at) VALUES (?, ?, ?, NULL, ?)',
      pollId,
      title,
      adminKey,
      Date.now(),
    );
  }

  // ---------------------------------------------------------------------
  // fetch(): WebSocket 업그레이드 전용 진입점 (role/key 검증 후 accept)
  // ---------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    const offeredProtocols = request.headers.get('Sec-WebSocket-Protocol')?.split(',').map((value) => value.trim()) ?? [];
    const adminProtocol = offeredProtocols.find((value) => value.startsWith('pollplus-admin.'));
    const key = adminProtocol?.slice('pollplus-admin.'.length) ?? null;

    if (role !== 'admin' && role !== 'participant' && role !== 'viewer') {
      return new Response('invalid role', { status: 400 });
    }

    const poll = this.getPoll();
    if (!poll) {
      return new Response('poll not found', { status: 404 });
    }

    if (role === 'admin' && key !== poll.admin_key) {
      return new Response('unauthorized', { status: 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const attachment: SocketAttachment = {
      role,
      socketTag: crypto.randomUUID(),
      answered: {},
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [role]);

    this.sendState(server, role);
    this.sendActiveResultsOnConnect(server, role);
    if (role === 'participant') this.broadcastPresence();

    return new Response(null, {
      status: 101,
      webSocket: client,
      ...(role === 'admin' && adminProtocol ? { headers: { 'Sec-WebSocket-Protocol': adminProtocol } } : {}),
    });
  }

  // ---------------------------------------------------------------------
  // Hibernation 핸들러
  // ---------------------------------------------------------------------

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message !== 'string') return;

    let value: unknown;
    try {
      value = JSON.parse(message);
    } catch {
      return;
    }
    const parsed = parseClientMessage(value);
    if (!parsed) return;

    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) return;

    if (parsed.type === 'submit') {
      if (attachment.role !== 'participant') return;
      this.handleSubmit(ws, attachment, parsed.questionId, parsed.payload);
      return;
    }

    // 나머지는 전부 admin 전용 오퍼레이션
    if (attachment.role !== 'admin') return;

    switch (parsed.type) {
      case 'add_question':
        this.handleAddQuestion(ws, parsed.input);
        break;
      case 'update_question':
        this.handleUpdateQuestion(ws, parsed.questionId, parsed.patch);
        break;
      case 'delete_question':
        this.handleDeleteQuestion(ws, parsed.questionId);
        break;
      case 'reorder_questions':
        this.handleReorder(ws, parsed.questionIds);
        break;
      case 'set_active':
        this.handleSetActive(parsed.questionId);
        break;
      case 'set_accepting':
        this.handleSetAccepting(parsed.questionId, parsed.accepting);
        break;
      case 'set_results_visible':
        this.handleSetResultsVisible(parsed.questionId, parsed.visible);
        break;
      case 'hide_response':
        this.handleHideResponse(parsed.responseId);
        break;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (attachment?.role === 'participant') this.broadcastPresence();
  }

  async webSocketError(): Promise<void> {
    // Hibernation이 연결 정리를 담당 — 별도 처리 불필요
  }

  // ---------------------------------------------------------------------
  // 문항 CRUD 핸들러 (비활성 문항은 자유, 활성 문항은 구조 변경 거부)
  // ---------------------------------------------------------------------

  private handleAddQuestion(ws: WebSocket, input: NewQuestionInput) {
    if (this.getQuestions().length >= MAX_QUESTIONS) {
      return this.send(ws, { type: 'error', reason: `문항은 최대 ${MAX_QUESTIONS}개까지 만들 수 있습니다.` });
    }
    const rows = this.ctx.storage.sql.exec<MaxPositionRow>('SELECT MAX(position) as maxPos FROM questions').toArray();
    const position = (rows[0]?.maxPos ?? -1) + 1;
    const id = crypto.randomUUID();

    this.ctx.storage.sql.exec(
      'INSERT INTO questions (id, type, prompt, options, correct_option_id, position, accepting, results_visible) VALUES (?, ?, ?, ?, ?, ?, 0, 1)',
      id,
      input.type,
      input.prompt,
      input.options ? JSON.stringify(input.options) : null,
      input.correctOptionId ?? null,
      position,
    );

    this.broadcastAdminState();
  }

  private handleUpdateQuestion(ws: WebSocket, questionId: string, patch: QuestionPatch) {
    const poll = this.requirePoll();
    const question = this.getQuestion(questionId);
    if (!question) return this.send(ws, { type: 'error', reason: 'question not found' });

    const isActive = poll.active_question_id === questionId;
    const structuralChange = patch.options !== undefined || patch.correctOptionId !== undefined;
    if (isActive && structuralChange) {
      return this.send(ws, {
        type: 'error',
        reason: '활성 문항의 선택지/정답은 편집할 수 없습니다. 먼저 다른 문항으로 전환하세요.',
      });
    }

    const nextPrompt = patch.prompt ?? question.prompt;
    const nextOptions: QuestionOption[] | undefined =
      patch.options ?? ('options' in question ? question.options : undefined);
    const nextCorrect: string | undefined =
      patch.correctOptionId ?? (question.type === 'quiz' ? question.correctOptionId : undefined);

    this.ctx.storage.sql.exec(
      'UPDATE questions SET prompt = ?, options = ?, correct_option_id = ? WHERE id = ?',
      nextPrompt,
      nextOptions ? JSON.stringify(nextOptions) : null,
      nextCorrect ?? null,
      questionId,
    );

    this.broadcastAdminState();
    if (isActive) this.broadcastPublicState();
  }

  private handleDeleteQuestion(ws: WebSocket, questionId: string) {
    const poll = this.requirePoll();
    if (poll.active_question_id === questionId) {
      return this.send(ws, {
        type: 'error',
        reason: '지금 진행 중인 문항은 삭제할 수 없습니다. 먼저 다른 문항으로 전환하세요.',
      });
    }
    this.ctx.storage.sql.exec('DELETE FROM questions WHERE id = ?', questionId);
    this.ctx.storage.sql.exec('DELETE FROM responses WHERE question_id = ?', questionId);
    this.broadcastAdminState();
  }

  private handleReorder(ws: WebSocket, questionIds: string[]) {
    const knownIds = this.getQuestions().map((question) => question.id);
    if (questionIds.length !== knownIds.length || new Set(questionIds).size !== knownIds.length || questionIds.some((id) => !knownIds.includes(id))) {
      return this.send(ws, { type: 'error', reason: '문항 순서 정보가 올바르지 않습니다.' });
    }
    questionIds.forEach((id, index) => {
      this.ctx.storage.sql.exec('UPDATE questions SET position = ? WHERE id = ?', index, id);
    });
    this.broadcastAdminState();
  }

  // ---------------------------------------------------------------------
  // 3축 상태 핸들러: active_question_id(poll) / accepting·results_visible(question)
  // 서로 독립 — 서버는 어떤 축도 자동으로 결합하지 않는다(계획서 "3개의 독립 축").
  // ---------------------------------------------------------------------

  private handleSetActive(questionId: string | null) {
    if (questionId !== null && !this.getQuestion(questionId)) return;
    this.ctx.storage.sql.exec('UPDATE poll SET active_question_id = ?', questionId);
    this.broadcastAdminState();
    this.broadcastPublicState();
  }

  private handleSetAccepting(questionId: string, accepting: boolean) {
    if (!this.getQuestion(questionId)) return;
    this.ctx.storage.sql.exec('UPDATE questions SET accepting = ? WHERE id = ?', accepting ? 1 : 0, questionId);
    this.broadcastAdminState();
    const poll = this.requirePoll();
    if (poll.active_question_id === questionId) this.broadcastPublicState();
  }

  private handleSetResultsVisible(questionId: string, visible: boolean) {
    if (!this.getQuestion(questionId)) return;
    this.ctx.storage.sql.exec(
      'UPDATE questions SET results_visible = ? WHERE id = ?',
      visible ? 1 : 0,
      questionId,
    );
    this.broadcastAdminState();
    // blind 토글은 TV(viewer)의 results 표시를 즉시 바꿔야 하므로 results도 재브로드캐스트
    this.broadcastResults(questionId);
  }

  private handleHideResponse(responseId: string) {
    const rows = this.ctx.storage.sql
      .exec<QuestionIdRow>('SELECT question_id FROM responses WHERE id = ?', responseId)
      .toArray();
    const questionId = rows[0]?.question_id;
    if (!questionId) return;
    this.ctx.storage.sql.exec('UPDATE responses SET hidden = 1 WHERE id = ?', responseId);
    this.broadcastResults(questionId);
  }

  // ---------------------------------------------------------------------
  // 응답 제출: questionId·accepting·중복(소켓 기준)을 서버가 검증
  // ---------------------------------------------------------------------

  private handleSubmit(
    ws: WebSocket,
    attachment: SocketAttachment,
    questionId: string,
    payload: ResponsePayload,
  ) {
    const poll = this.requirePoll();
    const question = this.getQuestion(questionId);

    const reject = (reason: 'not_active' | 'not_accepting' | 'duplicate' | 'invalid') => {
      this.send(ws, { type: 'submit_ack', questionId, ok: false, reason });
    };

    if (!question || poll.active_question_id !== questionId) return reject('not_active');
    if (!question.accepting) return reject('not_accepting');
    if (attachment.answered[questionId]) return reject('duplicate');

    let quizFeedback: { correct: boolean; correctOptionId: string } | undefined;

    switch (question.type) {
      case 'multiple_choice':
      case 'quiz': {
        if (payload.kind !== 'choice' || !question.options.some((o) => o.id === payload.optionId)) {
          return reject('invalid');
        }
        if (question.type === 'quiz') {
          quizFeedback = {
            correct: payload.optionId === question.correctOptionId,
            correctOptionId: question.correctOptionId,
          };
        }
        break;
      }
      case 'open_text':
      case 'word_cloud': {
        if (payload.kind !== 'text' || payload.text.trim().length === 0) {
          return reject('invalid');
        }
        break;
      }
    }

    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      'INSERT INTO responses (id, question_id, socket_tag, payload, hidden, created_at) VALUES (?, ?, ?, ?, 0, ?)',
      id,
      questionId,
      attachment.socketTag,
      JSON.stringify(payload),
      Date.now(),
    );

    attachment.answered[questionId] = true;
    ws.serializeAttachment(attachment);

    this.send(ws, { type: 'submit_ack', questionId, ok: true, quiz: quizFeedback });
    this.broadcastResults(questionId);
  }

  // ---------------------------------------------------------------------
  // 조회 헬퍼
  // ---------------------------------------------------------------------

  private getPoll(): PollRow | null {
    const rows = this.ctx.storage.sql.exec<PollRow>('SELECT * FROM poll LIMIT 1').toArray();
    return rows[0] ?? null;
  }

  private requirePoll(): PollRow {
    const poll = this.getPoll();
    if (!poll) throw new Error('poll not initialized');
    return poll;
  }

  private rowToQuestion(row: QuestionRow): AdminQuestion {
    const base = {
      id: row.id,
      prompt: row.prompt,
      position: row.position,
      accepting: row.accepting === 1,
      resultsVisible: row.results_visible === 1,
    };
    switch (row.type) {
      case 'multiple_choice':
        return { ...base, type: 'multiple_choice', options: JSON.parse(row.options ?? '[]') };
      case 'quiz':
        return {
          ...base,
          type: 'quiz',
          options: JSON.parse(row.options ?? '[]'),
          correctOptionId: row.correct_option_id ?? '',
        };
      case 'open_text':
        return { ...base, type: 'open_text' };
      default:
        return { ...base, type: 'word_cloud' };
    }
  }

  private getQuestions(): AdminQuestion[] {
    const rows = this.ctx.storage.sql.exec<QuestionRow>('SELECT * FROM questions ORDER BY position ASC').toArray();
    return rows.map((r) => this.rowToQuestion(r));
  }

  private getQuestion(id: string): AdminQuestion | null {
    const rows = this.ctx.storage.sql.exec<QuestionRow>('SELECT * FROM questions WHERE id = ?', id).toArray();
    return rows[0] ? this.rowToQuestion(rows[0]) : null;
  }

  private getActiveQuestion(): AdminQuestion | null {
    const poll = this.getPoll();
    if (!poll?.active_question_id) return null;
    return this.getQuestion(poll.active_question_id);
  }

  // ---------------------------------------------------------------------
  // 집계
  // ---------------------------------------------------------------------

  private computeAggregate(question: AdminQuestion): Aggregate {
    const rows = this.ctx.storage.sql
      .exec<ResponseRow>(
        'SELECT * FROM responses WHERE question_id = ? AND hidden = 0 ORDER BY created_at ASC',
        question.id,
      )
      .toArray();

    if (question.type === 'multiple_choice' || question.type === 'quiz') {
      const counts: Record<string, number> = {};
      for (const opt of question.options) counts[opt.id] = 0;
      for (const row of rows) {
        const payload = JSON.parse(row.payload) as ResponsePayload;
        if (payload.kind === 'choice' && payload.optionId in counts) {
          counts[payload.optionId]++;
        }
      }
      if (question.type === 'quiz') {
        return { type: 'quiz', total: rows.length, counts, correctOptionId: question.correctOptionId };
      }
      return { type: 'multiple_choice', total: rows.length, counts };
    }

    const items: ResponseItem[] = rows.map((row) => {
      const payload = JSON.parse(row.payload) as ResponsePayload;
      return { id: row.id, text: payload.kind === 'text' ? payload.text : '', createdAt: row.created_at };
    });

    if (question.type === 'open_text') {
      return { type: 'open_text', items };
    }

    const wordCounts = new Map<string, number>();
    for (const item of items) {
      const key = item.text.trim();
      if (!key) continue;
      wordCounts.set(key, (wordCounts.get(key) ?? 0) + 1);
    }
    const words = [...wordCounts.entries()]
      .map(([text, count]) => ({ text, count }))
      .sort((a, b) => b.count - a.count);
    return { type: 'word_cloud', words, items };
  }

  // ---------------------------------------------------------------------
  // 브로드캐스트 (역할별 fan-out — ctx.getWebSockets(tag)로 role 태깅된 소켓만 선택)
  // ---------------------------------------------------------------------

  private send(ws: WebSocket, msg: ServerMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // 소켓이 이미 닫히는 중일 수 있음 — 무시
    }
  }

  private sendState(ws: WebSocket, role: Role) {
    if (role === 'admin') {
      this.send(ws, this.buildAdminStateMessage());
    } else {
      this.send(ws, { ...this.buildPublicStateContent(), role });
    }
    this.send(ws, this.buildPresenceMessage());
  }

  private buildAdminStateMessage(): ServerMessage {
    const poll = this.requirePoll();
    return {
      type: 'state',
      role: 'admin',
      poll: { id: poll.id, title: poll.title, createdAt: poll.created_at },
      questions: this.getQuestions(),
      activeQuestionId: poll.active_question_id,
    };
  }

  private buildPublicStateContent(): Omit<PublicStateMessage, 'role'> {
    const poll = this.requirePoll();
    const active = this.getActiveQuestion();
    return {
      type: 'state',
      poll: { id: poll.id, title: poll.title, createdAt: poll.created_at },
      activeQuestion: active ? toPublicQuestion(active) : null,
    };
  }

  private buildPresenceMessage(): ServerMessage {
    return { type: 'presence', participantCount: this.ctx.getWebSockets('participant').length };
  }

  private broadcastPresence() {
    const msg = this.buildPresenceMessage();
    for (const ws of this.ctx.getWebSockets('admin')) this.send(ws, msg);
    for (const ws of this.ctx.getWebSockets('viewer')) this.send(ws, msg);
    for (const ws of this.ctx.getWebSockets('participant')) this.send(ws, msg);
  }

  /** 문항 목록/구조가 바뀔 때마다 admin 전원에게 전체 상태 재전송("무캐싱 거울" — patch 아님) */
  private broadcastAdminState() {
    const msg = this.buildAdminStateMessage();
    for (const ws of this.ctx.getWebSockets('admin')) this.send(ws, msg);
  }

  /** 활성 문항이 바뀌거나(active/accepting/prompt) 참여자·TV가 봐야 할 게 바뀔 때 전체 재전송 */
  private broadcastPublicState() {
    const content = this.buildPublicStateContent();
    for (const ws of this.ctx.getWebSockets('participant')) this.send(ws, { ...content, role: 'participant' });
    for (const ws of this.ctx.getWebSockets('viewer')) this.send(ws, { ...content, role: 'viewer' });
  }

  private buildResultsMessages(question: AdminQuestion): { fullMsg: ServerMessage; viewerMsg: ServerMessage } {
    const aggregate = this.computeAggregate(question);
    const fullMsg: ServerMessage = { type: 'results', questionId: question.id, aggregate };
    const viewerAggregate: ViewerAggregate = question.resultsVisible
      ? this.toViewerAggregate(aggregate)
      : { type: 'hidden' };
    return { fullMsg, viewerMsg: { type: 'results', questionId: question.id, aggregate: viewerAggregate } };
  }

  /** 공개 TV에는 응답 원문·ID·시각을 전달하지 않는다. */
  private toViewerAggregate(aggregate: Aggregate): ViewerAggregate {
    switch (aggregate.type) {
      case 'multiple_choice':
      case 'quiz':
        return aggregate;
      case 'open_text':
        return { type: 'open_text', total: aggregate.items.length };
      case 'word_cloud':
        return { type: 'word_cloud', total: aggregate.items.length, words: aggregate.words };
      case 'hidden':
        return { type: 'hidden' };
    }
  }

  /** 새로 접속한 admin/viewer는 활성 문항의 "지금까지의" 집계를 즉시 받아야 한다 —
   *  안 그러면 이미 응답이 쌓인 문항에 늦게(혹은 재연결로) 들어온 화면이
   *  "응답을 기다리는 중"에서 멈춰있게 된다. */
  private sendActiveResultsOnConnect(ws: WebSocket, role: Role) {
    if (role !== 'admin' && role !== 'viewer') return;
    const active = this.getActiveQuestion();
    if (!active) return;
    const { fullMsg, viewerMsg } = this.buildResultsMessages(active);
    this.send(ws, role === 'admin' ? fullMsg : viewerMsg);
  }

  /** admin은 항상 실제 집계, viewer는 results_visible일 때만 실제 집계(아니면 count만).
   *  participant에겐 어떤 경로로도 전송하지 않음(프라이버시 불변식). */
  private broadcastResults(questionId: string) {
    const question = this.getQuestion(questionId);
    if (!question) return;

    const { fullMsg, viewerMsg } = this.buildResultsMessages(question);

    for (const ws of this.ctx.getWebSockets('admin')) this.send(ws, fullMsg);

    for (const ws of this.ctx.getWebSockets('viewer')) this.send(ws, viewerMsg);
  }
}

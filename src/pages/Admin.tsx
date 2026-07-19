import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { usePollSocket } from '../lib/usePollSocket';
import { saveRecentPoll } from '../lib/recentPolls';
import type {
  AdminAccessRequest,
  AdminAccessResponse,
  Aggregate,
  AdminQuestion,
  NewQuestionInput,
  QuestionOption,
  QuestionPatch,
  QuestionType,
  ResponseItem,
  ServerMessage,
  SubmissionMode,
} from '../../shared/types';

interface AdminView {
  poll: { id: string; title: string; createdAt: number } | null;
  questions: AdminQuestion[];
  activeQuestionId: string | null;
}

const TYPE_LABEL: Record<QuestionType, string> = {
  multiple_choice: '객관식',
  open_text: '자유 서술',
  word_cloud: '워드클라우드',
  quiz: '퀴즈',
};

function isChoiceType(type: QuestionType): type is 'multiple_choice' | 'quiz' {
  return type === 'multiple_choice' || type === 'quiz';
}

function newOptionId() {
  return crypto.randomUUID();
}

const SUBMISSION_LABEL: Record<SubmissionMode, string> = {
  single: '1회 제출',
  multiple: '여러 번 제출',
  replace: '답 변경',
};

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function Admin() {
  const { pollId = '' } = useParams();

  const [adminKey, setAdminKey] = useState(() => {
    const fromQuery = new URLSearchParams(window.location.search).get('k');
    const fromFragment = new URLSearchParams(window.location.hash.slice(1)).get('k');
    const fromUrl = fromFragment ?? fromQuery;
    const storageKey = `pollplus:adminKey:${pollId}`;
    if (fromUrl) {
      localStorage.setItem(storageKey, fromUrl);
      window.history.replaceState(null, '', window.location.pathname);
      return fromUrl;
    }
    return localStorage.getItem(storageKey) ?? '';
  });

  const [view, setView] = useState<AdminView>({ poll: null, questions: [], activeQuestionId: null });
  const [presence, setPresence] = useState(0);
  const [results, setResults] = useState<Record<string, Aggregate>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [copyNotice, setCopyNotice] = useState<string | null>(null);

  const handleMessage = useCallback((msg: ServerMessage) => {
    if (msg.type === 'state' && msg.role === 'admin') {
      setView({ poll: msg.poll, questions: msg.questions, activeQuestionId: msg.activeQuestionId });
      saveRecentPoll(msg.poll.id, msg.poll.title);
      return;
    }
    if (msg.type === 'presence') {
      setPresence(msg.participantCount);
      return;
    }
    if (msg.type === 'results') {
      // admin 소켓은 서버에서 항상 전체 Aggregate만 받는다.
      setResults((prev) => ({ ...prev, [msg.questionId]: msg.aggregate as Aggregate }));
      return;
    }
    if (msg.type === 'error') {
      setServerError(msg.reason);
    }
  }, []);

  const { status, send } = usePollSocket(pollId, 'admin', { adminKey, enabled: Boolean(adminKey), onMessage: handleMessage });

  // 실시간 경과 시간 표시용 1초 tick
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // selectedQuestionId 기본값/정리
  useEffect(() => {
    if (selectedQuestionId && !view.questions.some((q) => q.id === selectedQuestionId)) {
      setSelectedQuestionId(null);
    } else if (!selectedQuestionId && view.questions.length > 0) {
      setSelectedQuestionId(view.activeQuestionId ?? view.questions[0].id);
    }
  }, [view.questions, view.activeQuestionId, selectedQuestionId]);

  useEffect(() => {
    if (!serverError) return;
    const t = setTimeout(() => setServerError(null), 4000);
    return () => clearTimeout(t);
  }, [serverError]);

  useEffect(() => {
    if (!copyNotice) return;
    const t = setTimeout(() => setCopyNotice(null), 2000);
    return () => clearTimeout(t);
  }, [copyNotice]);

  const goToQuestion = (targetId: string) => {
    if (view.activeQuestionId && view.activeQuestionId !== targetId) {
      send({ type: 'set_accepting', questionId: view.activeQuestionId, accepting: false });
    }
    send({ type: 'set_active', questionId: targetId });
    send({ type: 'set_accepting', questionId: targetId, accepting: true });
  };

  const orderedIds = view.questions.map((q) => q.id);
  const activeIndex = view.activeQuestionId ? orderedIds.indexOf(view.activeQuestionId) : -1;

  const goPrev = () => {
    const prev = orderedIds[activeIndex - 1];
    if (prev) goToQuestion(prev);
  };
  const goNext = () => {
    const next = orderedIds[activeIndex + 1];
    if (next) goToQuestion(next);
  };

  const moveQuestion = (id: string, direction: -1 | 1) => {
    const ids = [...orderedIds];
    const idx = ids.indexOf(id);
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= ids.length) return;
    [ids[idx], ids[newIdx]] = [ids[newIdx], ids[idx]];
    send({ type: 'reorder_questions', questionIds: ids });
  };

  const deleteQuestion = (id: string) => {
    if (!window.confirm('이 문항을 삭제할까요? 응답 기록도 함께 사라져요.')) return;
    send({ type: 'delete_question', questionId: id });
  };

  const activeQuestion = view.questions.find((q) => q.id === view.activeQuestionId) ?? null;
  const selectedQuestion = view.questions.find((q) => q.id === selectedQuestionId) ?? null;
  const activeAggregate = view.activeQuestionId ? results[view.activeQuestionId] : undefined;

  const participantUrl = `${window.location.origin}/p/${pollId}`;
  const presentUrl = `${window.location.origin}/present/${pollId}`;

  const copyLink = async (url: string, label: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopyNotice(`${label} 복사했어요`);
    } catch {
      setCopyNotice('복사에 실패했어요');
    }
  };

  if (!adminKey) {
    return <AdminAccess pollId={pollId} onAccess={(key) => setAdminKey(key)} />;
  }

  if (status === 'rejected') {
    return (
      <div className="min-h-full flex items-center justify-center bg-bento-bg px-6">
        <div className="max-w-sm text-center">
          <p className="text-2xl mb-2">🔒</p>
          <h1 className="text-lg font-bold text-bento-ink mb-2">관리자 권한을 확인할 수 없어요</h1>
          <p className="text-sm text-bento-muted">이 기기에 저장된 관리자 권한이 만료되었거나 올바르지 않아요.</p>
          <button
            type="button"
            onClick={() => {
              localStorage.removeItem(`pollplus:adminKey:${pollId}`);
              setAdminKey('');
            }}
            className="mt-4 rounded-lg bg-bento-accent px-3 py-2 text-sm font-semibold text-white"
          >
            비밀번호로 다시 인증
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-bento-bg text-bento-ink">
      <header className="border-b border-bento-border px-6 py-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-bento-muted">PollPlus · 제작자</p>
          <h1 className="text-lg font-bold">{view.poll?.title ?? '불러오는 중…'}</h1>
        </div>
        <div className="flex items-center gap-4 text-xs text-bento-muted">
          <span>{status === 'open' ? '🟢 연결됨' : '연결 중…'}</span>
          {copyNotice && <span className="text-bento-accent font-semibold">{copyNotice}</span>}
        </div>
      </header>

      {serverError && (
        <div className="mx-6 mt-4 rounded-lg border border-bento-bad bg-bento-bad-soft px-4 py-2 text-sm text-bento-bad">
          {serverError}
        </div>
      )}

      <main className="p-6 flex flex-col gap-4">
        <StatsStrip
          presence={presence}
          elapsed={formatElapsed(now - (view.poll?.createdAt ?? now))}
          activeLabel={activeIndex >= 0 ? `${activeIndex + 1} / ${view.questions.length}` : `- / ${view.questions.length}`}
          responseTotal={aggregateTotal(activeAggregate)}
        />

        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr_260px] gap-4 items-start">
          <QuestionSidebar
            questions={view.questions}
            activeQuestionId={view.activeQuestionId}
            selectedQuestionId={selectedQuestionId}
            adding={adding}
            onSelect={setSelectedQuestionId}
            onStart={goToQuestion}
            onMove={moveQuestion}
            onDelete={deleteQuestion}
            onAddClick={() => setAdding(true)}
          />

          <div className="flex flex-col gap-4">
            <NavBar
              activeQuestion={activeQuestion}
              hasPrev={activeIndex > 0}
              hasNext={activeIndex >= 0 && activeIndex < orderedIds.length - 1}
              onPrev={goPrev}
              onNext={goNext}
              onSetAccepting={(v) =>
                view.activeQuestionId && send({ type: 'set_accepting', questionId: view.activeQuestionId, accepting: v })
              }
              onSetVisible={(v) =>
                view.activeQuestionId && send({ type: 'set_results_visible', questionId: view.activeQuestionId, visible: v })
              }
            />

            {adding ? (
              <AddQuestionForm
                onCancel={() => setAdding(false)}
                onSubmit={(input) => {
                  send({ type: 'add_question', input });
                  setAdding(false);
                }}
              />
            ) : (
              <QuestionEditor
                key={selectedQuestion?.id ?? 'none'}
                question={selectedQuestion}
                isActive={selectedQuestion?.id === view.activeQuestionId}
                onSave={(patch) => selectedQuestion && send({ type: 'update_question', questionId: selectedQuestion.id, patch })}
              />
            )}

            <ResultsPanel
              question={activeQuestion}
              aggregate={activeAggregate}
              onHideResponse={(responseId) => send({ type: 'hide_response', responseId })}
            />
          </div>

          <LinksCard participantUrl={participantUrl} presentUrl={presentUrl} onCopy={copyLink} />
        </div>
      </main>
    </div>
  );
}

function AdminAccess(props: { pollId: string; onAccess: (adminKey: string) => void }) {
  const { pollId, onAccess } = props;
  const [password, setPassword] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const credential = useRecoveryCode ? recoveryCode.trim() : password;
    if (!credential || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const body: AdminAccessRequest = useRecoveryCode ? { recoveryCode: credential } : { password: credential };
      const response = await fetch(`/api/polls/${pollId}/admin-access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result: AdminAccessResponse = await response.json();
      if (!response.ok || !result.ok) {
        if (!result.ok && result.reason === 'rate_limited') throw new Error('시도 횟수가 많아요. 10분 후에 다시 시도해주세요.');
        if (!result.ok && result.reason === 'password_not_configured') throw new Error('이전 방식으로 만든 설문이라 비밀번호가 설정되지 않았어요. 기존 기기의 관리자 링크를 사용해주세요.');
        throw new Error('비밀번호 또는 복구 코드가 올바르지 않아요.');
      }
      localStorage.setItem(`pollplus:adminKey:${pollId}`, result.adminKey);
      onAccess(result.adminKey);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '관리자 권한을 확인하지 못했어요.');
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center bg-bento-bg px-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-bento-border bg-bento-surface p-6">
        <p className="text-xs font-semibold tracking-wide uppercase text-bento-muted">PollPlus · 관리자</p>
        <h1 className="mt-1 text-xl font-bold text-bento-ink">설문 관리하기</h1>
        <p className="mt-2 text-sm text-bento-muted">방 번호 <b className="font-mono text-bento-ink">{pollId}</b>의 관리자 비밀번호를 입력하세요.</p>
        <input
          type={useRecoveryCode ? 'text' : 'password'}
          value={useRecoveryCode ? recoveryCode : password}
          onChange={(event) => (useRecoveryCode ? setRecoveryCode(event.target.value) : setPassword(event.target.value))}
          placeholder={useRecoveryCode ? '복구 코드' : '관리자 비밀번호'}
          autoComplete={useRecoveryCode ? 'off' : 'current-password'}
          className="mt-5 w-full rounded-xl border border-bento-border bg-bento-bg px-4 py-3 text-bento-ink placeholder:text-bento-muted focus:outline-none focus:ring-2 focus:ring-bento-accent"
        />
        <button type="submit" disabled={!((useRecoveryCode ? recoveryCode : password).trim()) || submitting} className="mt-3 w-full rounded-xl bg-bento-accent px-4 py-3 font-semibold text-white disabled:opacity-40">
          {submitting ? '확인 중…' : '관리자 화면 열기'}
        </button>
        <button type="button" onClick={() => { setUseRecoveryCode((value) => !value); setError(null); }} className="mt-3 w-full text-xs font-semibold text-bento-accent">
          {useRecoveryCode ? '비밀번호로 인증하기' : '비밀번호를 잊었어요 · 복구 코드 사용'}
        </button>
        {error && <p className="mt-3 text-sm text-bento-bad">{error}</p>}
      </form>
    </div>
  );
}

function aggregateTotal(agg?: Aggregate): number {
  if (!agg) return 0;
  switch (agg.type) {
    case 'multiple_choice':
    case 'quiz':
    case 'hidden':
      return agg.total;
    case 'open_text':
    case 'word_cloud':
      return agg.items.length;
  }
}

// ---------------------------------------------------------------------------
// Stats strip
// ---------------------------------------------------------------------------

function StatsStrip(props: { presence: number; elapsed: string; activeLabel: string; responseTotal: number }) {
  const items = [
    { label: '참여자', value: props.presence },
    { label: '현재 문항 응답', value: props.responseTotal },
    { label: '진행 시간', value: props.elapsed },
    { label: '활성 문항', value: props.activeLabel },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {items.map((it) => (
        <div key={it.label} className="rounded-xl border border-bento-border bg-bento-surface px-4 py-3">
          <span className="block text-xs text-bento-muted mb-1">{it.label}</span>
          <b className="text-xl tracking-tight">{it.value}</b>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 문항 목록 사이드바
// ---------------------------------------------------------------------------

function QuestionSidebar(props: {
  questions: AdminQuestion[];
  activeQuestionId: string | null;
  selectedQuestionId: string | null;
  adding: boolean;
  onSelect: (id: string) => void;
  onStart: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onDelete: (id: string) => void;
  onAddClick: () => void;
}) {
  const { questions, activeQuestionId, selectedQuestionId, adding, onSelect, onStart, onMove, onDelete, onAddClick } = props;

  return (
    <div className="rounded-2xl border border-bento-border bg-bento-surface p-4 flex flex-col gap-1">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-bento-muted">문항 목록</h3>
        <button
          type="button"
          onClick={onAddClick}
          className={
            'text-xs font-bold rounded-lg border border-dashed px-2 py-1 ' +
            (adding ? 'border-bento-accent bg-bento-accent-soft text-bento-accent' : 'border-bento-accent text-bento-accent hover:bg-bento-accent-soft')
          }
        >
          + 추가
        </button>
      </div>

      {questions.length === 0 && <p className="text-xs text-bento-muted py-4 text-center">아직 문항이 없어요</p>}

      {questions.map((q, i) => {
        const isActive = q.id === activeQuestionId;
        const isSelected = q.id === selectedQuestionId && !isActive;
        return (
          <div
            key={q.id}
            onClick={() => onSelect(q.id)}
            className={
              'flex items-start gap-2 rounded-lg px-2 py-2 cursor-pointer border-l-[3px] ' +
              (isActive
                ? 'bg-bento-accent-soft border-bento-accent'
                : isSelected
                  ? 'border-bento-good border-dashed'
                  : 'border-transparent hover:bg-bento-bg')
            }
          >
            <span className="text-[11px] text-bento-muted w-4 pt-0.5 tabular-nums">{i + 1}</span>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] leading-snug truncate">{q.prompt || '(제목 없음)'}</p>
              <div className="flex items-center gap-1.5 mt-1">
                <span
                  className={
                    'text-[9.5px] font-bold px-1.5 py-0.5 rounded-full ' +
                    (isActive ? 'bg-bento-accent text-white' : 'bg-bento-border text-bento-muted')
                  }
                >
                  {TYPE_LABEL[q.type]}
                </span>
                {isActive && (
                  <span className="text-[10px] font-bold text-bento-accent">
                    {q.accepting ? '● 진행 중' : '■ 마감'}
                  </span>
                )}
                {isSelected && <span className="text-[10px] font-bold text-bento-good">✎ 편집 중</span>}
              </div>
            </div>
            <div className="flex flex-col items-end gap-0.5 shrink-0">
              {!isActive && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onStart(q.id);
                  }}
                  className="text-[10px] font-bold text-bento-accent hover:underline"
                >
                  ▶ 시작
                </button>
              )}
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMove(q.id, -1);
                  }}
                  disabled={i === 0}
                  className="text-bento-muted disabled:opacity-20 text-xs"
                  aria-label="위로"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMove(q.id, 1);
                  }}
                  disabled={i === questions.length - 1}
                  className="text-bento-muted disabled:opacity-20 text-xs"
                  aria-label="아래로"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(q.id);
                  }}
                  disabled={isActive}
                  className="text-bento-bad disabled:opacity-20 text-xs"
                  aria-label="삭제"
                >
                  ×
                </button>
              </div>
            </div>
          </div>
        );
      })}

      <p className="text-[10.5px] text-bento-muted leading-relaxed mt-2 pt-2 border-t border-dashed border-bento-border">
        비활성 문항은 지금 진행 중인 문항과 무관하게 자유롭게 추가·편집할 수 있어요.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 이전/다음 · 응답받기 · 결과공개 (3축 컨트롤 바)
// ---------------------------------------------------------------------------

function NavBar(props: {
  activeQuestion: AdminQuestion | null;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onSetAccepting: (v: boolean) => void;
  onSetVisible: (v: boolean) => void;
}) {
  const { activeQuestion, hasPrev, hasNext, onPrev, onNext, onSetAccepting, onSetVisible } = props;

  return (
    <div className="rounded-2xl border border-bento-border bg-bento-surface px-4 py-3 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-xs">
        <button
          type="button"
          onClick={onPrev}
          disabled={!hasPrev}
          className="rounded-lg border border-bento-border px-2.5 py-1.5 disabled:opacity-30"
        >
          ◀ 이전
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!hasNext}
          className="rounded-lg bg-bento-accent text-white font-semibold px-2.5 py-1.5 disabled:opacity-30"
        >
          다음 ▶
        </button>
      </div>

      {activeQuestion ? (
        <div className="flex items-center gap-4 text-xs">
          <ToggleField
            label="응답 받기"
            checked={activeQuestion.accepting}
            onChange={onSetAccepting}
          />
          <ToggleField label="결과 공개" checked={activeQuestion.resultsVisible} onChange={onSetVisible} />
        </div>
      ) : (
        <span className="text-xs text-bento-muted">진행 중인 문항이 없어요</span>
      )}
    </div>
  );
}

function ToggleField(props: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <span className="text-bento-muted">{props.label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        onClick={() => props.onChange(!props.checked)}
        className={
          'relative w-8 h-[18px] rounded-full transition-colors ' + (props.checked ? 'bg-bento-accent' : 'bg-bento-border')
        }
      >
        <span
          className={
            'absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ' +
            (props.checked ? 'translate-x-[16px]' : 'translate-x-0.5')
          }
        />
      </button>
    </label>
  );
}

// ---------------------------------------------------------------------------
// 문항 추가 폼
// ---------------------------------------------------------------------------

function AddQuestionForm(props: { onCancel: () => void; onSubmit: (input: NewQuestionInput) => void }) {
  const [type, setType] = useState<QuestionType>('multiple_choice');
  const [prompt, setPrompt] = useState('');
  const [options, setOptions] = useState<QuestionOption[]>([
    { id: newOptionId(), text: '' },
    { id: newOptionId(), text: '' },
  ]);
  const [correctOptionId, setCorrectOptionId] = useState<string>('');
  const [submissionMode, setSubmissionMode] = useState<SubmissionMode>('single');
  const [maxSubmissions, setMaxSubmissions] = useState(3);

  const choiceType = isChoiceType(type);

  const submit = () => {
    if (!prompt.trim()) return;
    const input: NewQuestionInput = {
      type,
      prompt: prompt.trim(),
      submissionMode,
      maxSubmissions: submissionMode === 'multiple' ? maxSubmissions : 1,
    };
    if (choiceType) {
      const cleaned = options.filter((o) => o.text.trim().length > 0);
      if (cleaned.length < 2) return;
      input.options = cleaned;
      if (type === 'quiz') {
        input.correctOptionId = cleaned.some((o) => o.id === correctOptionId) ? correctOptionId : cleaned[0].id;
      }
    }
    props.onSubmit(input);
  };

  return (
    <div className="rounded-2xl border border-bento-accent bg-bento-surface p-4 flex flex-col gap-3">
      <h3 className="text-sm font-bold">새 문항 추가</h3>
      <div className="grid grid-cols-4 gap-2">
        {(Object.keys(TYPE_LABEL) as QuestionType[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setType(t)}
            className={
              'rounded-lg border px-2 py-2 text-xs font-semibold ' +
              (type === t ? 'border-bento-accent bg-bento-accent-soft text-bento-accent' : 'border-bento-border text-bento-muted')
            }
          >
            {TYPE_LABEL[t]}
          </button>
        ))}
      </div>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="질문 내용을 입력하세요"
        rows={2}
        className="w-full rounded-lg border border-bento-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-bento-accent"
      />

      <SubmissionPolicyFields
        mode={submissionMode}
        maxSubmissions={maxSubmissions}
        onModeChange={setSubmissionMode}
        onMaxChange={setMaxSubmissions}
      />

      {choiceType && (
        <OptionsEditor
          options={options}
          setOptions={setOptions}
          quiz={type === 'quiz'}
          correctOptionId={correctOptionId}
          setCorrectOptionId={setCorrectOptionId}
        />
      )}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={props.onCancel} className="text-xs px-3 py-2 text-bento-muted">
          취소
        </button>
        <button
          type="button"
          onClick={submit}
          className="text-xs font-semibold px-4 py-2 rounded-lg bg-bento-accent text-white"
        >
          추가하기
        </button>
      </div>
    </div>
  );
}

function OptionsEditor(props: {
  options: QuestionOption[];
  setOptions: (opts: QuestionOption[]) => void;
  quiz: boolean;
  correctOptionId: string;
  setCorrectOptionId: (id: string) => void;
}) {
  const { options, setOptions, quiz, correctOptionId, setCorrectOptionId } = props;
  return (
    <div className="flex flex-col gap-1.5">
      {options.map((opt, i) => (
        <div key={opt.id} className="flex items-center gap-2">
          {quiz && (
            <input
              type="radio"
              name="correct"
              checked={correctOptionId === opt.id}
              onChange={() => setCorrectOptionId(opt.id)}
              title="정답으로 표시"
            />
          )}
          <input
            value={opt.text}
            onChange={(e) => {
              const next = [...options];
              next[i] = { ...opt, text: e.target.value };
              setOptions(next);
            }}
            placeholder={`선택지 ${i + 1}`}
            className="flex-1 rounded-lg border border-bento-border px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-bento-accent"
          />
          <button
            type="button"
            onClick={() => setOptions(options.filter((o) => o.id !== opt.id))}
            disabled={options.length <= 2}
            className="text-bento-bad disabled:opacity-20 text-xs"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setOptions([...options, { id: newOptionId(), text: '' }])}
        className="self-start text-xs text-bento-accent font-semibold"
      >
        + 선택지 추가
      </button>
    </div>
  );
}

function SubmissionPolicyFields(props: {
  mode: SubmissionMode;
  maxSubmissions: number;
  onModeChange: (mode: SubmissionMode) => void;
  onMaxChange: (value: number) => void;
}) {
  const { mode, maxSubmissions, onModeChange, onMaxChange } = props;
  return (
    <div className="rounded-lg border border-bento-border bg-bento-bg p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <label className="text-xs font-semibold text-bento-muted">응답 방식</label>
        <select
          value={mode}
          onChange={(e) => onModeChange(e.target.value as SubmissionMode)}
          className="rounded-md border border-bento-border bg-bento-surface px-2 py-1.5 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-bento-accent"
        >
          {(Object.keys(SUBMISSION_LABEL) as SubmissionMode[]).map((value) => (
            <option key={value} value={value}>{SUBMISSION_LABEL[value]}</option>
          ))}
        </select>
      </div>
      {mode === 'multiple' && (
        <label className="flex items-center justify-between gap-3 text-xs text-bento-muted">
          연결당 최대 제출 횟수
          <input
            type="number"
            min={2}
            max={20}
            value={maxSubmissions}
            onChange={(e) => onMaxChange(Math.max(2, Math.min(20, Number(e.target.value) || 2)))}
            className="w-16 rounded-md border border-bento-border bg-bento-surface px-2 py-1 text-right text-xs focus:outline-none focus:ring-2 focus:ring-bento-accent"
          />
        </label>
      )}
      <p className="text-[11px] leading-relaxed text-bento-muted">
        {mode === 'single' && '한 번 제출하면 같은 연결에서는 다시 낼 수 없어요.'}
        {mode === 'multiple' && '응답마다 1.2초 간격을 두며, 설정한 횟수까지 집계에 모두 더해져요.'}
        {mode === 'replace' && '다시 제출하면 같은 연결에서 낸 이전 답을 새 답으로 바꿔요.'}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 문항 편집 (선택된 문항 — 활성 문항이면 구조 편집 잠금)
// ---------------------------------------------------------------------------

function QuestionEditor(props: {
  question: AdminQuestion | null;
  isActive: boolean;
  onSave: (patch: QuestionPatch) => void;
}) {
  const { question, isActive, onSave } = props;
  const [prompt, setPrompt] = useState(question?.prompt ?? '');
  const [options, setOptions] = useState<QuestionOption[]>(question && 'options' in question ? question.options : []);
  const [correctOptionId, setCorrectOptionId] = useState<string>(
    question?.type === 'quiz' ? question.correctOptionId : '',
  );
  const [submissionMode, setSubmissionMode] = useState<SubmissionMode>(question?.submissionMode ?? 'single');
  const [maxSubmissions, setMaxSubmissions] = useState(question?.maxSubmissions ?? 1);

  if (!question) {
    return (
      <div className="rounded-2xl border border-dashed border-bento-border p-6 text-center text-sm text-bento-muted">
        문항을 선택하거나 추가해보세요.
      </div>
    );
  }

  const choiceType = isChoiceType(question.type);
  const structureLocked = isActive; // 활성 문항의 선택지/정답은 편집 잠금

  const savePrompt = () => {
    if (prompt.trim() && prompt !== question.prompt) onSave({ prompt: prompt.trim() });
  };
  const saveOptions = () => {
    const cleaned = options.filter((o) => o.text.trim().length > 0);
    if (cleaned.length >= 2) onSave({ options: cleaned, correctOptionId: question.type === 'quiz' ? correctOptionId : undefined });
  };
  const saveSubmissionPolicy = () => {
    const nextMax = submissionMode === 'multiple' ? maxSubmissions : 1;
    if (submissionMode !== question.submissionMode || nextMax !== question.maxSubmissions) {
      onSave({ submissionMode, maxSubmissions: nextMax });
    }
  };

  return (
    <div className="rounded-2xl border border-bento-border bg-bento-surface p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-wide text-bento-muted">
          문항 편집 · {TYPE_LABEL[question.type]}
        </h3>
        {structureLocked && (
          <span className="text-[10px] text-bento-muted">진행 중인 문항은 선택지를 바꿀 수 없어요</span>
        )}
      </div>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onBlur={savePrompt}
        rows={2}
        className="w-full rounded-lg border border-bento-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-bento-accent"
      />

      <fieldset disabled={structureLocked} className="disabled:opacity-50">
        <SubmissionPolicyFields
          mode={submissionMode}
          maxSubmissions={maxSubmissions}
          onModeChange={setSubmissionMode}
          onMaxChange={setMaxSubmissions}
        />
        <button
          type="button"
          onClick={saveSubmissionPolicy}
          disabled={structureLocked}
          className="mt-2 text-xs font-semibold px-3 py-1.5 rounded-lg bg-bento-accent text-white disabled:opacity-40"
        >
          응답 방식 저장
        </button>
      </fieldset>

      {choiceType && (
        <fieldset disabled={structureLocked} className="disabled:opacity-50">
          <OptionsEditor
            options={options}
            setOptions={setOptions}
            quiz={question.type === 'quiz'}
            correctOptionId={correctOptionId}
            setCorrectOptionId={setCorrectOptionId}
          />
          <button
            type="button"
            onClick={saveOptions}
            disabled={structureLocked}
            className="mt-2 text-xs font-semibold px-3 py-1.5 rounded-lg bg-bento-accent text-white disabled:opacity-40"
          >
            선택지 저장
          </button>
        </fieldset>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 실시간 결과 (항상 활성 문항 기준)
// ---------------------------------------------------------------------------

function ResultsPanel(props: {
  question: AdminQuestion | null;
  aggregate?: Aggregate;
  onHideResponse: (responseId: string) => void;
}) {
  const { question, aggregate, onHideResponse } = props;

  if (!question) {
    return (
      <div className="rounded-2xl border border-dashed border-bento-border p-6 text-center text-sm text-bento-muted">
        지금 진행 중인 문항이 없어요. 왼쪽에서 문항을 골라 ▶ 시작을 눌러주세요.
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-bento-border bg-bento-surface p-4 flex flex-col gap-3">
      <h3 className="text-xs font-bold uppercase tracking-wide text-bento-muted">실시간 결과</h3>

      {!aggregate && <p className="text-sm text-bento-muted">응답을 기다리는 중…</p>}

      {aggregate?.type === 'multiple_choice' && (
        <ChoiceResults question={question} counts={aggregate.counts} total={aggregate.total} />
      )}
      {aggregate?.type === 'quiz' && (
        <ChoiceResults
          question={question}
          counts={aggregate.counts}
          total={aggregate.total}
          correctOptionId={aggregate.correctOptionId}
        />
      )}
      {aggregate?.type === 'open_text' && <ModerationList items={aggregate.items} onHide={onHideResponse} />}
      {aggregate?.type === 'word_cloud' && (
        <div className="flex flex-col gap-3">
          <WordCloudView words={aggregate.words} />
          <ModerationList items={aggregate.items} onHide={onHideResponse} compact />
        </div>
      )}
      {aggregate?.type === 'hidden' && <p className="text-sm text-bento-muted">{aggregate.total}명 응답함</p>}
    </div>
  );
}

function ChoiceResults(props: {
  question: AdminQuestion;
  counts: Record<string, number>;
  total: number;
  correctOptionId?: string;
}) {
  const { question, counts, total, correctOptionId } = props;
  if (!('options' in question)) return null;
  return (
    <div className="flex flex-col gap-2">
      {question.options.map((opt) => {
        const count = counts[opt.id] ?? 0;
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        const isCorrect = correctOptionId === opt.id;
        return (
          <div key={opt.id} className="grid grid-cols-[1fr_auto] items-center gap-2 text-sm">
            <div className="flex items-center gap-2">
              <span className={isCorrect ? 'font-bold text-bento-good' : ''}>
                {opt.text}
                {isCorrect ? ' ✓' : ''}
              </span>
            </div>
            <span className="text-xs text-bento-muted tabular-nums">
              {pct}% · {count}
            </span>
            <div className="col-span-2 h-2 rounded-full bg-bento-border overflow-hidden">
              <div
                className={'h-full rounded-full ' + (isCorrect ? 'bg-bento-good' : 'bg-bento-accent')}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WordCloudView(props: { words: { text: string; count: number }[] }) {
  const max = Math.max(1, ...props.words.map((w) => w.count));
  if (props.words.length === 0) return <p className="text-sm text-bento-muted">아직 응답이 없어요</p>;
  return (
    <div className="flex flex-wrap gap-2 items-baseline">
      {props.words.map((w) => {
        const scale = 12 + (w.count / max) * 20;
        return (
          <span
            key={w.text}
            className="font-bold text-bento-accent"
            style={{ fontSize: `${scale}px` }}
            title={`${w.count}회`}
          >
            {w.text}
          </span>
        );
      })}
    </div>
  );
}

function ModerationList(props: { items: ResponseItem[]; onHide: (id: string) => void; compact?: boolean }) {
  const { items, onHide, compact } = props;
  if (items.length === 0) return <p className="text-sm text-bento-muted">아직 응답이 없어요</p>;
  return (
    <div className={compact ? 'flex flex-col gap-1 max-h-40 overflow-y-auto' : 'flex flex-col gap-1'}>
      {[...items]
        .reverse()
        .map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm border-b border-bento-border last:border-none"
          >
            <span className="flex-1 truncate">{item.text}</span>
            <button
              type="button"
              onClick={() => onHide(item.id)}
              className="w-5 h-5 shrink-0 rounded border border-bento-border text-bento-muted hover:border-bento-bad hover:text-bento-bad text-xs"
              aria-label="삭제"
            >
              ×
            </button>
          </div>
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 링크 카드
// ---------------------------------------------------------------------------

function LinksCard(props: { participantUrl: string; presentUrl: string; onCopy: (url: string, label: string) => void }) {
  const { participantUrl, presentUrl, onCopy } = props;
  return (
    <div className="rounded-2xl border border-bento-border bg-bento-surface p-4 flex flex-col gap-4">
      <h3 className="text-xs font-bold uppercase tracking-wide text-bento-muted">공유 링크</h3>

      <div>
        <p className="text-[11px] text-bento-muted mb-1">참여자 링크</p>
        <div className="rounded-lg border border-bento-border bg-bento-bg px-2.5 py-1.5 text-xs truncate mb-1.5 font-mono">
          {participantUrl}
        </div>
        <button
          type="button"
          onClick={() => onCopy(participantUrl, '참여자 링크')}
          className="w-full text-xs font-semibold rounded-lg bg-bento-accent text-white py-2"
        >
          참여자 링크 복사
        </button>
      </div>

      <div>
        <p className="text-[11px] text-bento-muted mb-1">TV 링크</p>
        <div className="rounded-lg border border-bento-border bg-bento-bg px-2.5 py-1.5 text-xs truncate mb-1.5 font-mono">
          {presentUrl}
        </div>
        <button
          type="button"
          onClick={() => onCopy(presentUrl, 'TV 링크')}
          className="w-full text-xs font-semibold rounded-lg border border-bento-accent text-bento-accent py-2"
        >
          TV 링크 복사
        </button>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { usePollSocket } from '../lib/usePollSocket';
import type { PublicQuestion, ResponsePublicationState, ServerMessage, ViewerAggregate } from '../../shared/types';

interface ViewState {
  poll: { id: string; title: string; createdAt: number } | null;
  activeQuestion: PublicQuestion | null;
}

interface TvControllerState {
  controllerId: string;
  activeQuestionId: string | null;
  hasPrev: boolean;
  hasNext: boolean;
  accepting: boolean;
  resultsVisible: boolean;
  moderation: { id: string; text: string }[];
}

type ControllerAction = 'prev' | 'next' | 'stop' | 'toggle_results' | 'set_response_state';

export default function Present() {
  const { pollId = '' } = useParams();
  const [view, setView] = useState<ViewState>({ poll: null, activeQuestion: null });
  const [presence, setPresence] = useState(0);
  const [resultsPair, setResultsPair] = useState<{ questionId: string; aggregate: ViewerAggregate } | null>(null);
  const [controller, setController] = useState<TvControllerState | null>(null);
  const prevIdRef = useRef<string | null>(null);

  const handleMessage = useCallback((msg: ServerMessage) => {
    if (msg.type === 'state' && msg.role === 'viewer') {
      const newId = msg.activeQuestion?.id ?? null;
      if (newId !== prevIdRef.current) {
        prevIdRef.current = newId;
        setResultsPair(null);
      }
      setView({ poll: msg.poll, activeQuestion: msg.activeQuestion });
      return;
    }
    if (msg.type === 'presence') {
      setPresence(msg.participantCount);
      return;
    }
    if (msg.type === 'results') setResultsPair({ questionId: msg.questionId, aggregate: msg.aggregate as ViewerAggregate });
  }, []);

  const { status } = usePollSocket(pollId, 'viewer', { onMessage: handleMessage });

  useEffect(() => {
    const opener = window.opener;
    if (!opener) return;
    const sendReady = () => opener.postMessage({ source: 'pollplus-tv', type: 'controller_ready' }, window.location.origin);
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || event.source !== opener || !event.data || typeof event.data !== 'object') return;
      const data = event.data as Record<string, unknown>;
      if (
        data.source !== 'pollplus-admin' ||
        data.type !== 'controller_state' ||
        typeof data.controllerId !== 'string' ||
        typeof data.activeQuestionId !== 'string' && data.activeQuestionId !== null ||
        typeof data.hasPrev !== 'boolean' ||
        typeof data.hasNext !== 'boolean' ||
        typeof data.accepting !== 'boolean' ||
        typeof data.resultsVisible !== 'boolean' ||
        !Array.isArray(data.moderation)
      ) return;
      const moderation = data.moderation.filter(
        (item): item is { id: string; text: string } =>
          item !== null && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string' && typeof (item as Record<string, unknown>).text === 'string',
      );
      setController({
        controllerId: data.controllerId,
        activeQuestionId: data.activeQuestionId,
        hasPrev: data.hasPrev,
        hasNext: data.hasNext,
        accepting: data.accepting,
        resultsVisible: data.resultsVisible,
        moderation,
      });
    };
    window.addEventListener('message', receive);
    sendReady();
    return () => window.removeEventListener('message', receive);
  }, []);

  const question = view.activeQuestion;
  const aggregate = resultsPair && resultsPair.questionId === question?.id ? resultsPair.aggregate : undefined;
  const activeController = controller?.activeQuestionId === question?.id ? controller : null;

  const sendControllerCommand = (action: ControllerAction, options?: { responseId?: string; state?: ResponsePublicationState }) => {
    if (!activeController || !window.opener) return;
    window.opener.postMessage(
      { source: 'pollplus-tv', type: 'controller_command', controllerId: activeController.controllerId, action, ...options },
      window.location.origin,
    );
  };

  if (status === 'rejected') {
    return <StatusScreen text="설문을 찾을 수 없어요. 링크를 다시 확인해주세요." />;
  }
  if (status !== 'open') return <StatusScreen text="연결 중…" />;

  return (
    <div className="relative min-h-full overflow-hidden bg-bento-bg text-bento-ink">
      <div className="pointer-events-none absolute -left-24 top-1/4 h-72 w-72 rounded-full bg-bento-accent-soft blur-3xl" />
      <div className="pointer-events-none absolute -right-32 bottom-0 h-96 w-96 rounded-full bg-bento-accent-soft/70 blur-3xl" />
      {activeController && <TeacherControls controller={activeController} onCommand={sendControllerCommand} />}

      <main className="presentation-scene relative mx-auto flex min-h-full w-full max-w-7xl flex-col px-6 py-6 sm:px-10 sm:py-8">
        <header className="flex items-center justify-between gap-4 font-mono text-xs font-semibold tracking-wide text-bento-muted sm:text-sm">
          <span className="inline-flex items-center gap-2 text-bento-accent">
            <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-bento-accent opacity-60" /><span className="relative inline-flex h-2 w-2 rounded-full bg-bento-accent" /></span>
            LIVE · {presence}명 참여 중
          </span>
          <span className="max-w-[48%] truncate">{view.poll?.title ?? 'PollPlus'}</span>
        </header>

        {!question ? (
          <WaitingStage title={view.poll?.title ?? 'PollPlus'} pollId={pollId} />
        ) : (
          <section key={question.id} className="flex flex-1 flex-col justify-center py-8">
            <p className="mb-3 font-mono text-xs font-bold tracking-[0.16em] text-bento-accent">{questionTypeLabel(question.type)}</p>
            <h1 className="max-w-5xl text-4xl font-black leading-[1.08] tracking-tight text-balance sm:text-6xl lg:text-7xl">{question.prompt}</h1>
            <ResultsView question={question} aggregate={aggregate} controller={activeController} onCommand={sendControllerCommand} />
          </section>
        )}

        <footer className="mt-auto pt-6 text-center font-mono text-xs text-bento-muted sm:text-sm">
          참여하기 → <b className="text-bento-ink">{window.location.origin}/p/{pollId}</b>
        </footer>
      </main>
    </div>
  );
}

function StatusScreen(props: { text: string }) {
  return <div className="min-h-full flex items-center justify-center bg-bento-bg text-sm text-bento-muted">{props.text}</div>;
}

function WaitingStage(props: { title: string; pollId: string }) {
  return (
    <section className="flex flex-1 flex-col items-center justify-center text-center">
      <p className="font-mono text-xs font-bold tracking-[0.18em] text-bento-accent">POLLPLUS LIVE</p>
      <h1 className="mt-4 text-5xl font-black tracking-tight sm:text-7xl">{props.title}</h1>
      <div className="mt-10 rounded-full border border-bento-border bg-bento-surface px-6 py-3 text-lg font-bold">질문을 기다리는 중이에요</div>
      <p className="mt-4 text-sm text-bento-muted">교사가 문항을 시작하면 이 화면이 바뀝니다.</p>
    </section>
  );
}

function questionTypeLabel(type: PublicQuestion['type']): string {
  return ({ multiple_choice: 'CHOICE RACE', quiz: 'QUIZ', word_cloud: 'WORD FIELD', open_text: 'RESPONSE WALL' })[type];
}

function ResultsView(props: {
  question: PublicQuestion;
  aggregate?: ViewerAggregate;
  controller: TvControllerState | null;
  onCommand: (action: ControllerAction, options?: { responseId?: string; state?: ResponsePublicationState }) => void;
}) {
  const { question, aggregate, controller, onCommand } = props;
  if (!aggregate) return <p className="mt-10 text-lg font-semibold text-bento-muted">결과를 기다리는 중…</p>;
  if (aggregate.type === 'hidden') return <div className="mt-10 rounded-3xl border border-dashed border-bento-border bg-bento-surface/70 px-8 py-10 text-center text-2xl font-bold">결과는 잠시 후 공개돼요</div>;
  if ((aggregate.type === 'multiple_choice' || aggregate.type === 'quiz') && 'options' in question) return <ChoiceRace question={question} aggregate={aggregate} />;
  if (aggregate.type === 'word_cloud') return <WordField words={aggregate.words} total={aggregate.total} controller={controller} onCommand={onCommand} />;
  if (aggregate.type === 'open_text') return <ResponseWall items={aggregate.items} total={aggregate.total} controller={controller} onCommand={onCommand} />;
  return null;
}

function ChoiceRace(props: {
  question: Extract<PublicQuestion, { type: 'multiple_choice' | 'quiz' }>;
  aggregate: Extract<ViewerAggregate, { type: 'multiple_choice' | 'quiz' }>;
}) {
  const { question, aggregate } = props;
  const ordered = [...question.options].sort((a, b) => (aggregate.counts[b.id] ?? 0) - (aggregate.counts[a.id] ?? 0));
  return (
    <div className="mt-10 grid w-full max-w-5xl gap-3">
      {ordered.map((option, index) => {
        const count = aggregate.counts[option.id] ?? 0;
        const percent = aggregate.total ? Math.round((count / aggregate.total) * 100) : 0;
        const correct = aggregate.type === 'quiz' && aggregate.correctOptionId === option.id;
        return (
          <div key={option.id} className={'grid grid-cols-[2.5rem_minmax(0,1fr)_4.5rem] items-center gap-3 rounded-2xl border p-3 sm:grid-cols-[3.5rem_minmax(0,1fr)_5.5rem] sm:p-4 ' + (correct ? 'border-bento-good bg-bento-good/10' : 'border-bento-border bg-bento-surface/80')}>
            <span className="font-mono text-sm font-bold text-bento-muted">{String(index + 1).padStart(2, '0')}</span>
            <div className="min-w-0">
              <div className="mb-2 flex items-center justify-between gap-3"><span className={'truncate text-left text-lg font-black sm:text-2xl ' + (correct ? 'text-bento-good' : '')}>{option.text}{correct ? ' ✓' : ''}</span><span className="font-mono text-xs text-bento-muted">{count}표</span></div>
              <div className="h-3 overflow-hidden rounded-full bg-bento-border"><div className={'h-full rounded-full transition-[width] duration-500 ease-out ' + (correct ? 'bg-bento-good' : 'bg-bento-accent')} style={{ width: `${percent}%` }} /></div>
            </div>
            <span className="text-right text-2xl font-black tabular-nums sm:text-3xl">{percent}%</span>
          </div>
        );
      })}
    </div>
  );
}

function WordField(props: {
  words: { text: string; count: number }[];
  total: number;
  controller: TvControllerState | null;
  onCommand: (action: ControllerAction, options?: { responseId?: string; state?: ResponsePublicationState }) => void;
}) {
  const { words, total, controller, onCommand } = props;
  const max = Math.max(1, ...words.map((word) => word.count));
  const responseIdsByWord = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const item of controller?.moderation ?? []) map.set(item.text, [...(map.get(item.text) ?? []), item.id]);
    return map;
  }, [controller]);
  if (!words.length) return <EmptyResults total={total} label="응답이 도착하면 단어가 모여요" />;
  return (
    <div className="mt-10 flex min-h-64 max-w-5xl flex-wrap items-center justify-center gap-x-7 gap-y-5 rounded-[2rem] border border-bento-border bg-bento-surface/70 px-6 py-10 sm:min-h-80 sm:px-12">
      {words.map((word, index) => {
        const responseId = responseIdsByWord.get(word.text)?.at(-1);
        return (
          <span key={word.text} className="presentation-word group relative inline-flex items-center font-black text-bento-accent" style={{ fontSize: `${24 + (word.count / max) * 58}px`, animationDelay: `${Math.min(index * 40, 500)}ms` }}>
            {word.text}
            {controller && responseId && <button type="button" onClick={() => onCommand('set_response_state', { responseId, state: 'hidden' })} className="absolute -right-3 -top-2 hidden h-5 w-5 rounded-full border border-bento-bad bg-bento-surface text-[10px] text-bento-bad group-hover:block" aria-label={`${word.text} 한 건 숨기기`}>×</button>}
          </span>
        );
      })}
    </div>
  );
}

function ResponseWall(props: {
  items: { text: string }[];
  total: number;
  controller: TvControllerState | null;
  onCommand: (action: ControllerAction, options?: { responseId?: string; state?: ResponsePublicationState }) => void;
}) {
  const { items, total, controller, onCommand } = props;
  const visibleItems = items.slice(-6);
  const firstIndex = Math.max(0, items.length - visibleItems.length);
  if (!items.length) {
    return <EmptyResults total={total} label={total > 0 ? '응답이 도착했고, 교사가 검토 중이에요' : '아직 응답이 없어요'} />;
  }
  return (
    <div className="mt-10 grid w-full max-w-6xl grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {visibleItems.map((item, index) => {
        const responseId = controller?.moderation[firstIndex + index]?.id;
        return (
          <article key={`${item.text}-${firstIndex + index}`} className="presentation-card group relative flex min-h-32 items-center rounded-3xl border border-bento-border bg-bento-surface p-5 text-left shadow-sm sm:min-h-40 sm:p-6">
            <p className="text-xl font-bold leading-snug sm:text-2xl">{item.text}</p>
            {controller && responseId && <button type="button" onClick={() => onCommand('set_response_state', { responseId, state: 'hidden' })} className="absolute right-3 top-3 hidden rounded-full border border-bento-bad bg-bento-surface px-2 py-1 text-[10px] font-bold text-bento-bad group-hover:block">송출에서 숨김</button>}
          </article>
        );
      })}
    </div>
  );
}

function EmptyResults(props: { total: number; label: string }) {
  return <div className="mt-10 rounded-3xl border border-dashed border-bento-border bg-bento-surface/60 px-8 py-10 text-center"><p className="text-2xl font-black">{props.label}</p>{props.total > 0 && <p className="mt-2 font-mono text-sm text-bento-muted">{props.total}개 응답 도착</p>}</div>;
}

function TeacherControls(props: {
  controller: TvControllerState;
  onCommand: (action: ControllerAction) => void;
}) {
  const { controller, onCommand } = props;
  return (
    <div className="group fixed right-3 top-3 z-20 sm:right-5 sm:top-5">
      <div className="rounded-full border border-bento-border bg-bento-surface/90 px-3 py-2 text-[11px] font-bold text-bento-muted shadow-sm opacity-25 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">교사 제어</div>
      <div className="pointer-events-none absolute right-0 top-full mt-2 flex w-max translate-y-1 flex-wrap justify-end gap-2 rounded-2xl border border-bento-border bg-bento-surface/95 p-2 opacity-0 shadow-lg transition-all group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:translate-y-0 group-focus-within:opacity-100">
        <button type="button" onClick={() => onCommand('prev')} disabled={!controller.hasPrev} className="rounded-xl border border-bento-border px-3 py-2 text-xs font-bold disabled:opacity-30">◀ 이전</button>
        <button type="button" onClick={() => onCommand('next')} disabled={!controller.hasNext} className="rounded-xl bg-bento-accent px-3 py-2 text-xs font-bold text-white disabled:opacity-30">다음 ▶</button>
        <button type="button" onClick={() => onCommand('toggle_results')} className="rounded-xl border border-bento-border px-3 py-2 text-xs font-bold">{controller.resultsVisible ? '결과 숨김' : '결과 공개'}</button>
        <button type="button" onClick={() => onCommand('stop')} disabled={!controller.activeQuestionId} className="rounded-xl border border-bento-bad px-3 py-2 text-xs font-bold text-bento-bad disabled:opacity-30">■ 멈춤</button>
      </div>
    </div>
  );
}

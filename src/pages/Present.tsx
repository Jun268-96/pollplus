import { useCallback, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { usePollSocket } from '../lib/usePollSocket';
import type { PublicQuestion, ServerMessage, ViewerAggregate } from '../../shared/types';

interface ViewState {
  poll: { id: string; title: string; createdAt: number } | null;
  activeQuestion: PublicQuestion | null;
}

export default function Present() {
  const { pollId = '' } = useParams();

  const [view, setView] = useState<ViewState>({ poll: null, activeQuestion: null });
  const [presence, setPresence] = useState(0);
  const [resultsPair, setResultsPair] = useState<{ questionId: string; aggregate: ViewerAggregate } | null>(null);
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
    if (msg.type === 'results') {
      setResultsPair({ questionId: msg.questionId, aggregate: msg.aggregate as ViewerAggregate });
    }
  }, []);

  const { status } = usePollSocket(pollId, 'viewer', { onMessage: handleMessage });

  const question = view.activeQuestion;
  const aggregate = resultsPair && resultsPair.questionId === question?.id ? resultsPair.aggregate : undefined;

  if (status === 'rejected') {
    return (
      <div className="min-h-full flex items-center justify-center bg-bento-bg text-bento-muted text-sm">
        설문을 찾을 수 없어요. 링크를 다시 확인해주세요.
      </div>
    );
  }

  if (status !== 'open') {
    return (
      <div className="min-h-full flex items-center justify-center bg-bento-bg text-bento-muted text-sm">
        연결 중…
      </div>
    );
  }

  return (
    <div className="min-h-full flex flex-col items-center justify-center bg-bento-bg text-bento-ink px-10 py-10 gap-8 text-center">
      <span className="inline-flex items-center gap-2 font-mono text-sm font-semibold text-bento-accent">
        <span className="relative flex w-2 h-2">
          <span className="absolute inline-flex h-full w-full rounded-full bg-bento-accent opacity-60 animate-ping" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-bento-accent" />
        </span>
        LIVE · {presence}명 참여 중
      </span>

      {!question ? (
        <div>
          <p className="text-4xl font-extrabold mb-3">{view.poll?.title ?? 'PollPlus'}</p>
          <p className="text-bento-muted">질문을 기다리는 중이에요</p>
        </div>
      ) : (
        <>
          <h1 className="text-4xl font-extrabold leading-tight tracking-tight text-balance max-w-3xl">
            {question.prompt}
          </h1>
          <ResultsView question={question} aggregate={aggregate} />
        </>
      )}

      <p className="font-mono text-sm text-bento-muted">
        참여하기 → <b className="text-bento-ink">{window.location.origin}/p/{pollId}</b>
      </p>
    </div>
  );
}

function ResultsView(props: { question: PublicQuestion; aggregate?: ViewerAggregate }) {
  const { question, aggregate } = props;

  if (!aggregate) {
    return <p className="text-bento-muted">결과를 기다리는 중…</p>;
  }

  if (aggregate.type === 'hidden') {
    return (
      <div className="flex flex-col items-center gap-2">
        <p className="text-2xl">🙈 결과는 잠시 후 공개돼요</p>
      </div>
    );
  }

  if (aggregate.type === 'multiple_choice' || aggregate.type === 'quiz') {
    if (!('options' in question)) return null;
    return (
      <div className="flex flex-col gap-3 w-full max-w-xl">
        {question.options.map((opt) => {
          const count = aggregate.counts[opt.id] ?? 0;
          const pct = aggregate.total > 0 ? Math.round((count / aggregate.total) * 100) : 0;
          const isCorrect = aggregate.type === 'quiz' && aggregate.correctOptionId === opt.id;
          return (
            <div key={opt.id} className="grid grid-cols-[130px_1fr_70px] items-center gap-3 text-base font-semibold">
              <span className={'text-left truncate' + (isCorrect ? ' text-bento-good' : '')}>
                {opt.text}
                {isCorrect ? ' ✓' : ''}
              </span>
              <div className="h-4 rounded-full bg-bento-border overflow-hidden">
                <div
                  className={'h-full rounded-full ' + (isCorrect ? 'bg-bento-good' : 'bg-bento-accent')}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-right text-bento-muted tabular-nums">{pct}%</span>
            </div>
          );
        })}
      </div>
    );
  }

  if (aggregate.type === 'word_cloud') {
    const max = Math.max(1, ...aggregate.words.map((w) => w.count));
    if (aggregate.words.length === 0) return <p className="text-bento-muted">아직 응답이 없어요</p>;
    return (
      <div className="flex flex-wrap gap-4 items-baseline justify-center max-w-3xl">
        {aggregate.words.map((w) => (
          <span
            key={w.text}
            className="font-extrabold text-bento-accent"
            style={{ fontSize: `${20 + (w.count / max) * 48}px` }}
          >
            {w.text}
          </span>
        ))}
      </div>
    );
  }

  // open_text — 원문은 moderation을 위한 admin 화면에만 전달한다.
  if (aggregate.total === 0) return <p className="text-bento-muted">아직 응답이 없어요</p>;
  return (
    <p className="text-xl font-semibold text-bento-muted">{aggregate.total}개의 응답이 모였어요</p>
  );
}

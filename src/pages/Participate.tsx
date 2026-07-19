import { useCallback, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { usePollSocket } from '../lib/usePollSocket';
import type { PublicQuestion, ServerMessage } from '../../shared/types';

interface ViewState {
  poll: { id: string; title: string; createdAt: number } | null;
  activeQuestion: PublicQuestion | null;
}

type SubmitState = 'idle' | 'sending' | 'done' | 'error';

function reasonText(reason?: string): string {
  switch (reason) {
    case 'not_active':
      return '이 문항은 더 이상 진행 중이 아니에요.';
    case 'not_accepting':
      return '이 문항은 마감되었어요.';
    case 'duplicate':
      return '이미 제출했어요.';
    case 'invalid':
      return '제출값이 올바르지 않아요.';
    default:
      return '제출하지 못했어요. 다시 시도해주세요.';
  }
}

export default function Participate() {
  const { pollId = '' } = useParams();

  const [view, setView] = useState<ViewState>({ poll: null, activeQuestion: null });
  const [presence, setPresence] = useState(0);
  const [choice, setChoice] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [ackReason, setAckReason] = useState<string | undefined>(undefined);
  const [quizFeedback, setQuizFeedback] = useState<{ correct: boolean; correctOptionId: string } | null>(null);

  const prevQuestionIdRef = useRef<string | null>(null);

  const handleMessage = useCallback((msg: ServerMessage) => {
    if (msg.type === 'state' && msg.role === 'participant') {
      const newId = msg.activeQuestion?.id ?? null;
      if (newId !== prevQuestionIdRef.current) {
        prevQuestionIdRef.current = newId;
        setChoice(null);
        setText('');
        setSubmitState('idle');
        setAckReason(undefined);
        setQuizFeedback(null);
      }
      setView({ poll: msg.poll, activeQuestion: msg.activeQuestion });
      return;
    }
    if (msg.type === 'presence') {
      setPresence(msg.participantCount);
      return;
    }
    if (msg.type === 'submit_ack') {
      if (msg.ok) {
        setSubmitState('done');
        setQuizFeedback(msg.quiz ?? null);
      } else {
        setSubmitState('error');
        setAckReason(msg.reason);
      }
    }
  }, []);

  const { status, send } = usePollSocket(pollId, 'participant', { onMessage: handleMessage });

  const question = view.activeQuestion;
  const locked = submitState === 'sending' || submitState === 'done';

  const submitChoice = (optionId: string) => {
    if (!question || locked) return;
    setChoice(optionId);
    setSubmitState('sending');
    send({ type: 'submit', questionId: question.id, payload: { kind: 'choice', optionId } });
  };

  const submitText = () => {
    if (!question || locked) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    setSubmitState('sending');
    send({ type: 'submit', questionId: question.id, payload: { kind: 'text', text: trimmed } });
  };

  const handleTextKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // IME 조합 중 Enter 중복 제출 가드
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitText();
    }
  };

  if (status === 'rejected') {
    return (
      <div className="min-h-full flex flex-col items-center justify-center gap-2 bg-stage-bg text-stage-ink">
        <p className="text-sm text-stage-muted">설문을 찾을 수 없어요. 링크를 다시 확인해주세요.</p>
      </div>
    );
  }

  // ---- 연결 중: 재연결 시에도 여기로 — 옛 화면을 이어 붙이지 않는다 ----
  if (status !== 'open') {
    return (
      <div className="min-h-full flex flex-col items-center justify-center gap-3 bg-stage-bg text-stage-ink">
        <span className="inline-block w-2.5 h-2.5 rounded-full bg-stage-accent animate-pulse" />
        <p className="text-sm text-stage-muted">연결 중…</p>
      </div>
    );
  }

  return (
    <div className="min-h-full flex flex-col bg-stage-bg text-stage-ink px-6 py-6">
      <div className="flex items-center justify-between font-mono text-xs tracking-wide text-stage-muted max-w-xl w-full mx-auto">
        <span className="inline-flex items-center gap-1.5 font-semibold text-stage-accent">
          <span className="relative flex w-1.5 h-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-stage-accent opacity-60 animate-ping" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-stage-accent" />
          </span>
          LIVE · {presence}명 참여 중
        </span>
        <span className="truncate max-w-[50%]">{view.poll?.title}</span>
      </div>

      <div className="flex-1 flex flex-col justify-center max-w-xl w-full mx-auto gap-6 py-10">
        {!question ? (
          <div className="text-center">
            <p className="text-2xl font-extrabold mb-2">질문을 기다리는 중이에요</p>
            <p className="text-sm text-stage-muted">교사가 문항을 시작하면 여기에 바로 나타나요.</p>
          </div>
        ) : (
          <QuestionBody
            question={question}
            choice={choice}
            text={text}
            setText={setText}
            locked={locked}
            submitState={submitState}
            ackReason={ackReason}
            quizFeedback={quizFeedback}
            onSubmitChoice={submitChoice}
            onSubmitText={submitText}
            onTextKeyDown={handleTextKeyDown}
          />
        )}
      </div>

      <p className="text-center text-xs text-stage-muted">응답은 익명으로 처리돼요</p>
    </div>
  );
}

function typeLabel(type: PublicQuestion['type']): string {
  switch (type) {
    case 'multiple_choice':
      return '객관식';
    case 'open_text':
      return '자유 서술';
    case 'word_cloud':
      return '워드클라우드';
    case 'quiz':
      return '퀴즈';
  }
}

function QuestionBody(props: {
  question: PublicQuestion;
  choice: string | null;
  text: string;
  setText: (v: string) => void;
  locked: boolean;
  submitState: SubmitState;
  ackReason?: string;
  quizFeedback: { correct: boolean; correctOptionId: string } | null;
  onSubmitChoice: (optionId: string) => void;
  onSubmitText: () => void;
  onTextKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const { question, choice, text, setText, locked, submitState, ackReason, quizFeedback, onSubmitChoice, onSubmitText, onTextKeyDown } = props;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <span className="font-mono text-xs uppercase tracking-wide text-stage-muted">{typeLabel(question.type)}</span>
        <h1 className="text-3xl font-extrabold leading-tight tracking-tight mt-2 text-balance">{question.prompt}</h1>
      </div>

      {(question.type === 'multiple_choice' || question.type === 'quiz') && (
        <div className="flex flex-col gap-2.5">
          {question.options.map((opt) => {
            const picked = choice === opt.id;
            const isCorrect = quizFeedback && opt.id === quizFeedback.correctOptionId;
            const isWrongPick = quizFeedback && picked && !quizFeedback.correct;
            return (
              <button
                key={opt.id}
                type="button"
                disabled={locked}
                onClick={() => onSubmitChoice(opt.id)}
                className={
                  'w-full rounded-full border px-5 py-3.5 text-center font-semibold transition-colors disabled:cursor-not-allowed ' +
                  (isCorrect
                    ? 'bg-stage-accent border-stage-accent text-stage-accent-ink'
                    : isWrongPick
                      ? 'border-stage-line bg-stage-line/40 text-stage-muted line-through'
                      : picked
                        ? 'bg-stage-accent border-stage-accent text-stage-accent-ink'
                        : 'border-stage-line bg-stage-ink/5 hover:border-stage-accent')
                }
              >
                {opt.text}
              </button>
            );
          })}
        </div>
      )}

      {(question.type === 'open_text' || question.type === 'word_cloud') && (
        <div className="flex flex-col gap-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onTextKeyDown}
            disabled={locked}
            rows={question.type === 'word_cloud' ? 1 : 4}
            placeholder={question.type === 'word_cloud' ? '한 단어로…' : '여기에 적어보세요…'}
            className="w-full rounded-xl border border-stage-line bg-stage-ink/5 px-4 py-3 text-stage-ink placeholder:text-stage-muted focus:outline-none focus:ring-2 focus:ring-stage-accent disabled:opacity-50"
          />
          <button
            type="button"
            disabled={locked || !text.trim()}
            onClick={onSubmitText}
            className="w-full rounded-full bg-stage-accent px-5 py-3 font-semibold text-stage-accent-ink disabled:opacity-40 disabled:cursor-not-allowed"
          >
            제출하기
          </button>
        </div>
      )}

      {submitState === 'done' && (
        <p className="text-center text-sm font-semibold text-stage-accent">
          {quizFeedback ? (quizFeedback.correct ? '정답이에요! 🎉' : '아쉬워요, 오답이에요.') : '제출 완료!'}
        </p>
      )}
      {submitState === 'error' && <p className="text-center text-sm text-stage-muted">{reasonText(ackReason)}</p>}
    </div>
  );
}

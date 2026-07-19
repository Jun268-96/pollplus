export interface RecentPoll {
  pollId: string;
  title: string;
  lastOpenedAt: number;
}

const STORAGE_KEY = 'pollplus:recentPolls';
const MAX_RECENT_POLLS = 12;

export function saveRecentPoll(pollId: string, title: string): void {
  const existing = getRecentPolls().filter((poll) => poll.pollId !== pollId);
  const next = [{ pollId, title, lastOpenedAt: Date.now() }, ...existing].slice(0, MAX_RECENT_POLLS);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function getRecentPolls(): RecentPoll[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(
      (poll): poll is RecentPoll =>
        typeof poll === 'object' &&
        poll !== null &&
        'pollId' in poll &&
        'title' in poll &&
        'lastOpenedAt' in poll &&
        typeof poll.pollId === 'string' &&
        typeof poll.title === 'string' &&
        typeof poll.lastOpenedAt === 'number',
    );
  } catch {
    return [];
  }
}

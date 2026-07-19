import type { PollRoom } from './PollRoom';

export interface Env {
  POLL_ROOM: DurableObjectNamespace<PollRoom>;
  ASSETS: Fetcher;
}

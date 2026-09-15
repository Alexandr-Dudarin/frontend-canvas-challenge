import type { GenerationData } from '@canvas/contracts';
import { normalizeError, type ApiRequestError } from '../api/apiError';
import type { ApiResponse } from '../api/httpClient';

export type ScheduleAfter = (callback: () => void, delayMs: number) => () => void;
export const scheduleAfter: ScheduleAfter = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

export function retryAfterMs(header: string | null, fallbackMs: number, now = Date.now()) {
  if (header !== null && /^\d+(\.\d+)?$/.test(header.trim())) {
    const milliseconds = Number(header) * 1000;
    if (Number.isFinite(milliseconds) && milliseconds <= 2_147_483_647) return milliseconds;
  }
  if (header !== null) {
    const date = Date.parse(header);
    if (Number.isFinite(date) && date > now && date - now <= 2_147_483_647) return date - now;
  }
  return fallbackMs;
}

export function startGenerationPolling(options: {
  initial: GenerationData;
  retryAfter: string | null;
  fallbackMs: number;
  read: (signal: AbortSignal) => Promise<ApiResponse<GenerationData>>;
  onData: (generation: GenerationData) => void;
  onError: (error: ApiRequestError) => void;
  scheduleAfter?: ScheduleAfter;
  now?: () => number;
}) {
  let stopped = false;
  let cancelTimer: (() => void) | undefined;
  let request: AbortController | undefined;

  function stop() {
    stopped = true;
    cancelTimer?.();
    cancelTimer = undefined;
    request?.abort();
    request = undefined;
  }
  function schedule(header: string | null) {
    cancelTimer = (options.scheduleAfter ?? scheduleAfter)(
      () => {
        cancelTimer = undefined;
        void poll();
      },
      retryAfterMs(header, options.fallbackMs, options.now?.()),
    );
  }
  async function poll() {
    if (stopped || request) return;
    const current = new AbortController();
    request = current;
    try {
      const response = await options.read(current.signal);
      // Abort экономит запрос, а identity guard защищает даже от позднего ответа адаптера.
      if (stopped || request !== current) return;
      request = undefined;
      options.onData(response.data);
      if (response.data.status !== 'processing') stop();
      else if (!stopped) schedule(response.meta.retryAfter);
    } catch (error) {
      if (stopped || request !== current) return;
      request = undefined;
      stop();
      options.onError(normalizeError(error));
    }
  }
  if (options.initial.status === 'processing') schedule(options.retryAfter);
  return { stop };
}

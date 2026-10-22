import type { AndroidSupportState } from './platform/android/androidSupport.ts';

/** The support prompt waits for this many finished jobs after install or after the last prompt. */
export const SUPPORT_PROMPT_AFTER_JOBS = 10;

export const SUPPORT_JOBS_KEY = 'pdfchef.support.finished-jobs.v1';
export const SUPPORT_PROMPTED_BUILD_KEY = 'pdfchef.support.prompted-build.v1';

/** Support is offered only when Google Play has a price to show and the person has not supported yet. */
export const isSupportOffered = (state: AndroidSupportState | null): state is AndroidSupportState =>
  state !== null
  && state.status === 'ready'
  && state.supporter === 'none'
  && (state.monthlyPrice !== null || state.yearlyPrice !== null || state.lifetimePrice !== null);

/** At most one prompt per app update, and never before the person has finished enough jobs. */
export const shouldOfferSupport = ({ state, finishedJobs, build, promptedBuild }: {
  state: AndroidSupportState | null;
  finishedJobs: number;
  build: string;
  promptedBuild: string | null;
}): boolean =>
  isSupportOffered(state)
  && !state.pending
  && finishedJobs >= SUPPORT_PROMPT_AFTER_JOBS
  && build !== ''
  && promptedBuild !== build;

const read = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Without storage the prompt simply cannot count; it never blocks a job.
  }
};

export const readFinishedJobs = (): number => {
  const count = Number.parseInt(read(SUPPORT_JOBS_KEY) ?? '', 10);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
};

/** Counting stops at the threshold, so a busy person does not write storage on every job. */
export const countFinishedJob = () => {
  const count = readFinishedJobs();
  if (count < SUPPORT_PROMPT_AFTER_JOBS) write(SUPPORT_JOBS_KEY, String(count + 1));
};

export const readPromptedBuild = (): string | null => read(SUPPORT_PROMPTED_BUILD_KEY);

/** The next prompt needs both a new app update and another round of finished jobs. */
export const markSupportPrompted = (build: string) => {
  write(SUPPORT_PROMPTED_BUILD_KEY, build);
  write(SUPPORT_JOBS_KEY, '0');
};

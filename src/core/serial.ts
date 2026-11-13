/**
 * One thing at a time: each job starts when the one before it has finished (whether that one worked or failed), so a
 * slow earlier Save can never finish after, and overwrite, a later one. A failed job does not stop the ones queued behind it.
 */
export function serialQueue(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return job => {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** A problem to show the person as it is: the message already says what went wrong and what to do. */
export class FsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FsError';
  }
}

/**
 * A save meant to replace the copy the person opened found a different copy there (saved meanwhile in another window
 * or on another device). Nothing was written; `current` is the copy there now, for asking before replacing it.
 */
export class FileChanged extends FsError {
  readonly current: string;
  constructor(name: string, current: string) {
    super(`“${name}” was changed after you opened it (in another window or on another device), so it was not replaced.`);
    this.name = 'FileChanged';
    this.current = current;
  }
}

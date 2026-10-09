/** A problem to show the person as it is: the message already says what went wrong and what to do. */
export class FsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FsError';
  }
}

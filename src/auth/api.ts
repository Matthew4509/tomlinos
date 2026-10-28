import type { VaultKeys, VaultState } from './vault.ts';

// The page's side of the accounts API (server/api/auth.php). Every call is on this site, carries the desktop's header
// (which another site cannot send), and sends the session cookie; the cookie itself is HttpOnly, so no script sees it.

export interface PublicUser {
  id: string;
  name: string;
  display: string;
  admin: boolean;
  totp: boolean;
  pin: boolean;
  recoveryLeft: number;
  created: number;
  disabled: boolean;
  recoveryKey: boolean;
  recoveryKeyMade: number;
  vault: VaultState;
  /** The unlock email, masked ("a***@example.com"), or '' when none is set. */
  unlockEmail?: string;
}
export interface AuthStatus {
  setup?: boolean;
  /** Set-up from another computer needs the one-time code kept on the server (tomlinos/data/accounts/SETUP-CODE.txt). */
  setupCode?: boolean;
  signedIn: boolean;
  stage?: '2fa';
  locked?: boolean;
  user?: PublicUser;
  adopted?: boolean;
  /** Only for the signed-in person: their wrapped file key, when their files are encrypted. While `locked`, only its
      `state` and `stale` (no wraps): do not apply it. */
  vaultKeys?: VaultKeys | null;
  /** Set by the sign-in screen (never by the server): the password just typed, so the files open without asking again. */
  password?: string;
  /** Set by the set-up screen: the owner chose to encrypt their files. */
  encrypt?: boolean;
  /** What the site shows anyone not signed in: the Reader (Sherlock Holmes, and Log in), or the sign-in. */
  front?: 'reader' | 'signin';
}
export interface WrapBody {
  salt: string;
  iter: number;
  wrapPw: string;
}
export interface SessionRow {
  id: string;
  current: boolean;
  created: number;
  seen: number;
  ip: string;
  agent: string;
  locked: boolean;
}
export interface HistoryRow {
  at: number;
  event: string;
  ip: string;
  agent: string;
  times?: number;
}

/** A refusal from the server, with its words (fault, reason, way out) and whether it means "signed out" or "locked". */
export class AuthFailure extends Error {
  readonly status: number;
  readonly data: Record<string, unknown>;
  constructor(status: number, message: string, data: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.data = data;
  }
  get signedOut(): boolean {
    return this.data.auth === 'signin';
  }
  get locked(): boolean {
    return this.data.auth === 'locked';
  }
}

export class AuthApi {
  readonly base: string;

  constructor(base: string) {
    this.base = base;
  }

  private async call<T>(op: string, body?: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}?op=${encodeURIComponent(op)}`, {
        method: body ? 'POST' : 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'X-Desktop-Store': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new AuthFailure(0, "The desktop's server could not be reached. Check the connection, then try again.", {});
    }
    let data: Record<string, unknown> = {};
    try {
      data = await res.json();
    } catch {
      // Not JSON: the message below covers it.
    }
    if (!res.ok) {
      const message = typeof data.error === 'string' ? data.error : `The server answered with an error (${res.status}). Try again; if it keeps happening, the server needs looking at.`;
      throw new AuthFailure(res.status, message, data);
    }
    return data as T;
  }

  status = () => this.call<AuthStatus>('status');
  setup = (name: string, display: string, password: string, setupCode = '') => this.call<AuthStatus>('setup', { name, display, password, setupCode });
  /** `extra`: the picture check's id and answer when the server asks (428), or an emailed unlock link's token. */
  login = (name: string, password: string, extra: { captchaId?: string; captcha?: string; unlock?: string } = {}) => this.call<AuthStatus>('login', { name, password, ...extra });
  captcha = () => this.call<{ id: string; svg: string }>('captcha');
  unlockMail = (name: string) => this.call<{ message: string }>('unlock-mail', { name });
  unlockLink = (token: string) => this.call<{ name: string; tries: number }>('unlock-link', { token });
  setUnlockEmail = (password: string, code: string, email: string) => this.call<{ user: PublicUser }>('unlock-email', { password, code, email });
  code = (code: string) => this.call<AuthStatus>('code', { code });
  logout = () => this.call<AuthStatus>('logout', {});
  lock = () => this.call<AuthStatus>('lock', {});
  unlockPin = (pin: string) => this.call<AuthStatus>('unlock', { pin });
  unlockPassword = (password: string, code: string) => this.call<AuthStatus>('unlock', { password, code });
  changePassword = (password: string, code: string, next: string, wrap: WrapBody | null) => this.call<{ endedOthers: number }>('password', { password, code, next, ...(wrap ?? {}) });
  recoveryKey = (password: string, code: string, rkAuth: string, wrapRk: string | null) => this.call<{ user: PublicUser }>('recovery-key', { password, code, rkAuth, ...(wrapRk ? { wrapRk } : {}) });
  vault = (state: VaultState, extra: Record<string, unknown> = {}) => this.call<{ user: PublicUser; vaultKeys: VaultKeys | null }>('vault', { state, ...extra });
  vaultRewrap = (rkAuth: string, wrap: WrapBody) => this.call<{ user: PublicUser; vaultKeys: VaultKeys | null }>('vault-rewrap', { rkAuth, ...wrap });
  vaultAbandon = (password: string, code: string) => this.call<{ user: PublicUser }>('vault-abandon', { confirm: 'start again', password, code });
  recoverStart = (name: string, rkAuth: string, code: string) => this.call<{ vaultKeys: VaultKeys | null }>('recover-start', { name, rkAuth, code });
  recoverFinish = (password: string, wrap: WrapBody | null) => this.call<AuthStatus>('recover-finish', { password, ...(wrap ?? {}) });
  setPin = (password: string, code: string, pin: string | null) => this.call<{ user: PublicUser }>('pin', { password, code, pin });
  totpBegin = (password: string, code: string) => this.call<{ secret: string; uri: string }>('totp-begin', { password, code });
  totpEnable = (code: string) => this.call<{ recovery: string[]; user: PublicUser }>('totp-enable', { code });
  totpDisable = (password: string, code: string) => this.call<{ user: PublicUser }>('totp-disable', { password, code });
  recoveryNew = (password: string, code: string) => this.call<{ recovery: string[]; user: PublicUser }>('recovery-new', { password, code });
  sessions = () => this.call<{ sessions: SessionRow[] }>('sessions');
  revoke = (id: string) => this.call<{ ended: number }>('revoke', { id });
  history = () => this.call<{ history: HistoryRow[] }>('history');
  users = () => this.call<{ users: PublicUser[] }>('users');
  setFront = (front: 'reader' | 'signin') => this.call<{ front: 'reader' | 'signin' }>('site-front', { front });
  /** `next` is the new person's first password; `password` and `code` are the owner's own. */
  userCreate = (name: string, display: string, next: string, password: string, code: string) => this.call<{ user: PublicUser }>('user-create', { name, display, next, password, code });
  /** `password` and `code` are the owner's own: setting someone's password opens their account. */
  userPassword = (id: string, next: string, password: string, code: string) => this.call<{ user: PublicUser }>('user-password', { id, next, password, code });
  userDisable = (id: string, disabled: boolean, password: string, code: string) => this.call<{ user: PublicUser }>('user-disable', { id, disabled, password, code });
  userTwoStepOff = (id: string, password: string, code: string) => this.call<{ user: PublicUser }>('user-2fa-off', { id, password, code });
}

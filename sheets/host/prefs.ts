// Small conveniences kept between runs (recent files, the last folder, the window's size, when updates were last
// checked). They live in the program's own browser storage; when it cannot be read, everything still works and
// simply starts fresh.
const PREFIX = 'tomlin-sheets:';

export function readValue<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

export function writeValue(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Not kept this time; nothing depends on it.
  }
}

export function readList(key: string): string[] {
  const list = readValue<unknown>(key);
  return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [];
}

export function writeList(key: string, list: string[]): void {
  writeValue(key, list);
}

export function memoryStorage() {
  const records = new Map<string, unknown>();
  let alarmAt: number | null = null;
  let tail = Promise.resolve();
  const recordsApi = {
    async get(key: string | string[]) {
      if (Array.isArray(key)) return new Map(key.filter(k => records.has(k)).map(k => [k, structuredClone(records.get(k))]));
      return structuredClone(records.get(key));
    },
    async put(key: string | Record<string, unknown>, value?: unknown) {
      for (const [name, data] of typeof key === "string" ? [[key, value] as const] : Object.entries(key)) {
        records.set(name, structuredClone(data));
      }
    },
    async delete(key: string) { return records.delete(key); },
    async deleteAll() { records.clear(); },
    async setAlarm(at: number) { alarmAt = at; },
    async getAlarm() { return alarmAt; },
  };
  return {...recordsApi, transaction<T>(callback: (tx: typeof recordsApi) => Promise<T>) {
    const result = tail.then(() => callback(recordsApi));
    tail = result.then(() => {}, () => {});
    return result;
  }};
}

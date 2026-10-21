// The app imports types from core, which pulls in the Workers SqlStorage type.
// This is just enough of its shape for the app's own type check.
interface SqlStorageCursor<T> extends Iterable<T> {
  toArray(): T[];
  one(): T;
}
interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T>;
}

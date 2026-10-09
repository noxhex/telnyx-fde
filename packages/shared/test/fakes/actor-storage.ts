/**
 * In-memory fake of an actor's durable storage (`this.ctx.storage`, the
 * `ActorStorage` interface from `@telnyx/edge-runtime`), for unit tests of
 * the actor adapters and their domain functions. It is assignable to the
 * `ActorStorage` surface the adapters use (`get`, `put`, `delete`, `list`,
 * `deleteAll` and the alarm), so a fake can stand in for `ctx.storage`.
 *
 * Platform semantics mirrored deliberately:
 *
 * - `put` serialises its value: the stored state is always a copy, so
 *   changing the original after `put` does not change what is stored, and
 *   `get` and `list` hand back copies, so changing a returned value does not
 *   either. Functions, class instances and circular references are rejected
 *   like the real storage codec does (`Date`, `Map`, `Set`, `RegExp`,
 *   `ArrayBuffer`, TypedArray and `BigInt` are accepted and copied).
 * - `list` returns a `Map<string, T>` in lexicographic key order, honouring
 *   `ListOptions` (`prefix`, `start` inclusive, `startAfter` exclusive,
 *   `end` exclusive, `reverse`, `limit` — default 128, capped at 1000).
 * - `deleteAll` clears all keys but NOT the alarm.
 * - `setAlarm` replaces any earlier alarm; `getAlarm` returns epoch ms or
 *   `null`.
 *
 * Every call is appended to `calls`; `reset()` clears that log (not the data
 * or the alarm).
 */

import type { ActorStorage, ListOptions } from "@telnyx/edge-runtime";

/** The `ActorStorage` surface the actor adapters and this fake implement. */
export type ActorStorageLike = Pick<
  ActorStorage,
  "get" | "put" | "delete" | "list" | "deleteAll" | "setAlarm" | "getAlarm" | "deleteAlarm"
>;

export type ActorStorageMethod =
  | "get"
  | "put"
  | "delete"
  | "list"
  | "deleteAll"
  | "setAlarm"
  | "getAlarm"
  | "deleteAlarm";

export interface ActorStorageFakeCall {
  method: ActorStorageMethod;
  key?: string;
}

export interface ActorStorageFake extends ActorStorageLike {
  readonly calls: ActorStorageFakeCall[];
  /** Clears the recorded calls, not the stored data or the alarm. */
  reset(): void;
}

const DEFAULT_LIST_LIMIT = 128;
const MAX_LIST_LIMIT = 1000;

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-copies a value the way the real storage codec serialises it, so the
 * fake never shares an object with its caller. JSON-native values plus
 * `Date`, `Map`, `Set`, `RegExp`, `ArrayBuffer` and TypedArray are copied
 * (and `BigInt` passes through); functions, class instances and circular
 * references throw, matching the runtime's documented `CodecError` cases.
 * Shared (non-circular) references are allowed and copied per occurrence.
 */
function copyForStorage<T>(value: T, path: Set<object> = new Set()): T {
  if (typeof value === "function") {
    throw new Error("ActorStorageFake: functions cannot be stored");
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (path.has(value)) {
    throw new Error("ActorStorageFake: circular references cannot be stored");
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }
  if (value instanceof RegExp) {
    return new RegExp(value.source, value.flags) as T;
  }
  if (value instanceof ArrayBuffer) {
    return value.slice(0) as T;
  }
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) {
      throw new Error("ActorStorageFake: class instances cannot be stored");
    }
    // Every concrete TypedArray implements slice() returning its own kind.
    return (value as unknown as { slice(): T }).slice();
  }
  path.add(value);
  try {
    if (value instanceof Map) {
      const copy = new Map<unknown, unknown>();
      for (const [k, v] of value) {
        copy.set(copyForStorage(k, path), copyForStorage(v, path));
      }
      return copy as T;
    }
    if (value instanceof Set) {
      const copy = new Set<unknown>();
      for (const item of value) {
        copy.add(copyForStorage(item, path));
      }
      return copy as T;
    }
    if (Array.isArray(value)) {
      return value.map((item) => copyForStorage(item, path)) as T;
    }
    if (isPlainObject(value)) {
      const copy: Record<string, unknown> = {};
      for (const [name, fieldValue] of Object.entries(value)) {
        copy[name] = copyForStorage(fieldValue, path);
      }
      return copy as T;
    }
    throw new Error("ActorStorageFake: class instances cannot be stored");
  } finally {
    path.delete(value);
  }
}

class ActorStorageFakeImpl implements ActorStorageFake {
  readonly calls: ActorStorageFakeCall[] = [];
  private readonly entries = new Map<string, unknown>();
  private alarmMs: number | null = null;

  async get<T = unknown>(key: string): Promise<T | undefined> {
    this.calls.push({ method: "get", key });
    const value = this.entries.get(key);
    if (value === undefined) {
      return undefined;
    }
    return copyForStorage(value) as T;
  }

  async put<T = unknown>(key: string, value: T): Promise<void> {
    this.calls.push({ method: "put", key });
    this.entries.set(key, copyForStorage(value));
  }

  async delete(key: string): Promise<boolean> {
    this.calls.push({ method: "delete", key });
    return this.entries.delete(key);
  }

  async list<T = unknown>(options: ListOptions = {}): Promise<Map<string, T>> {
    this.calls.push({ method: "list" });
    const { prefix, start, startAfter, end, reverse, limit } = options;
    let names = [...this.entries.keys()].sort();
    if (prefix !== undefined) {
      names = names.filter((name) => name.startsWith(prefix));
    }
    if (start !== undefined) {
      names = names.filter((name) => name >= start);
    }
    if (startAfter !== undefined) {
      names = names.filter((name) => name > startAfter);
    }
    if (end !== undefined) {
      names = names.filter((name) => name < end);
    }
    if (reverse === true) {
      names = names.reverse();
    }
    // Mirrors the documented limits: default page of 128, at most 1000.
    names = names.slice(0, Math.min(limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));
    const result = new Map<string, T>();
    for (const name of names) {
      result.set(name, copyForStorage(this.entries.get(name)) as T);
    }
    return result;
  }

  async deleteAll(): Promise<void> {
    this.calls.push({ method: "deleteAll" });
    // The alarm deliberately survives: the platform does not clear it on
    // deleteAll either.
    this.entries.clear();
  }

  async setAlarm(whenMs: number): Promise<void> {
    this.calls.push({ method: "setAlarm" });
    this.alarmMs = whenMs;
  }

  async getAlarm(): Promise<number | null> {
    this.calls.push({ method: "getAlarm" });
    return this.alarmMs;
  }

  async deleteAlarm(): Promise<void> {
    this.calls.push({ method: "deleteAlarm" });
    this.alarmMs = null;
  }

  reset(): void {
    this.calls.length = 0;
  }
}

export function createActorStorageFake(): ActorStorageFake {
  return new ActorStorageFakeImpl();
}

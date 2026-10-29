/**
 * packages/client/src/lib/semantic-guard/lib-defs.ts
 *
 * Comprehensive in-memory standard library declarations (lib.d.ts) for TypeScript compiler API.
 * Provides essential ECMAScript core types, utility types, JSX intrinsics, and standard globals
 * to eliminate false-positive diagnostics without loading external 40MB Node/DOM typings.
 */

export const MINIMAL_LIB_D_TS = `
// ── Core ECMAScript Interfaces ────────────────────────────────────────────────
interface Array<T> {
  length: number;
  [n: number]: T;
  push(...items: T[]): number;
  pop(): T | undefined;
  map<U>(callbackfn: (value: T, index: number, array: T[]) => U): U[];
  filter(predicate: (value: T, index: number, array: T[]) => unknown): T[];
  forEach(callbackfn: (value: T, index: number, array: T[]) => void): void;
  find(predicate: (value: T, index: number, obj: T[]) => boolean): T | undefined;
  findIndex(predicate: (value: T, index: number, obj: T[]) => boolean): number;
  indexOf(searchElement: T, fromIndex?: number): number;
  includes(searchElement: T, fromIndex?: number): boolean;
  join(separator?: string): string;
  slice(start?: number, end?: number): T[];
  reduce(callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: T[]) => T): T;
  reduce<U>(callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: T[]) => U, initialValue: U): U;
  concat(...items: (T | ConcatArray<T>)[]): T[];
  sort(compareFn?: (a: T, b: T) => number): this;
  reverse(): T[];
}

interface ConcatArray<T> {
  readonly length: number;
  readonly [n: number]: T;
  join(separator?: string): string;
  slice(start?: number, end?: number): T[];
}

interface Boolean {}
interface Function {
  apply(this: Function, thisArg: any, argArray?: any): any;
  call(this: Function, thisArg: any, ...argArray: any[]): any;
  bind(this: Function, thisArg: any, ...argArray: any[]): any;
}
interface IArguments {}
interface Number {
  toString(radix?: number): string;
  toFixed(fractionDigits?: number): string;
  valueOf(): number;
}
interface Object {
  toString(): string;
  valueOf(): Object;
  hasOwnProperty(v: string | number | symbol): boolean;
}
interface RegExp {
  exec(string: string): RegExpExecArray | null;
  test(string: string): boolean;
}
interface RegExpExecArray extends Array<string> {
  index: number;
  input: string;
}
interface String {
  length: number;
  charAt(pos: number): string;
  charCodeAt(index: number): number;
  concat(...strings: string[]): string;
  indexOf(searchString: string, position?: number): number;
  lastIndexOf(searchString: string, position?: number): number;
  slice(start?: number, end?: number): string;
  substring(start: number, end?: number): string;
  toLowerCase(): string;
  toUpperCase(): string;
  trim(): string;
  split(separator: string | RegExp, limit?: number): string[];
  startsWith(searchString: string, position?: number): boolean;
  endsWith(searchString: string, endPosition?: number): boolean;
  includes(searchString: string, position?: number): boolean;
  replace(searchValue: string | RegExp, replaceValue: string): string;
  match(matcher: { [Symbol.match](string: string): RegExpMatchArray | null }): RegExpMatchArray | null;
  match(regexp: string | RegExp): RegExpMatchArray | null;
}
interface RegExpMatchArray extends Array<string> {
  index?: number;
  input?: string;
  groups?: { [key: string]: string };
}

interface Symbol {
  toString(): string;
  valueOf(): symbol;
}

interface Error {
  name: string;
  message: string;
  stack?: string;
}
interface ErrorConstructor {
  new(message?: string): Error;
  (message?: string): Error;
  readonly prototype: Error;
}
declare var Error: ErrorConstructor;

interface Date {
  getTime(): number;
  toISOString(): string;
  toString(): string;
}
interface DateConstructor {
  new(): Date;
  new(value: number | string | Date): Date;
  now(): number;
}
declare var Date: DateConstructor;

interface Promise<T> {
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | Promise<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | Promise<TResult2>) | null
  ): Promise<TResult1 | TResult2>;
  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | Promise<TResult>) | null
  ): Promise<T | TResult>;
  finally(onfinally?: (() => void) | null): Promise<T>;
}

interface PromiseConstructor {
  resolve<T>(value: T | Promise<T>): Promise<T>;
  reject<T = never>(reason?: any): Promise<T>;
  all<T>(values: Iterable<T | Promise<T>>): Promise<T[]>;
}
declare var Promise: PromiseConstructor;

interface Map<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): this;
  has(key: K): boolean;
  delete(key: K): boolean;
  clear(): void;
  readonly size: number;
  forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void): void;
  keys(): Iterable<K>;
  values(): Iterable<V>;
  entries(): Iterable<[K, V]>;
}
interface MapConstructor {
  new <K, V>(entries?: readonly (readonly [K, V])[] | null): Map<K, V>;
}
declare var Map: MapConstructor;

interface Set<T> {
  add(value: T): this;
  has(value: T): boolean;
  delete(value: T): boolean;
  clear(): void;
  readonly size: number;
  forEach(callbackfn: (value: T, value2: T, set: Set<T>) => void): void;
  values(): Iterable<T>;
}
interface SetConstructor {
  new <T>(values?: readonly T[] | null): Set<T>;
}
declare var Set: SetConstructor;

interface ArrayBuffer {
  readonly byteLength: number;
  slice(begin: number, end?: number): ArrayBuffer;
}
interface ArrayBufferConstructor {
  new(byteLength: number): ArrayBuffer;
}
declare var ArrayBuffer: ArrayBufferConstructor;

interface Uint8Array {
  readonly length: number;
  readonly byteLength: number;
  readonly byteOffset: number;
  readonly buffer: ArrayBuffer;
  [index: number]: number;
  slice(start?: number, end?: number): Uint8Array;
  set(array: ArrayLike<number>, offset?: number): void;
}
interface Uint8ArrayConstructor {
  new(length: number): Uint8Array;
  new(array: ArrayLike<number> | ArrayBuffer): Uint8Array;
}
declare var Uint8Array: Uint8ArrayConstructor;

interface Iterable<T> {
  [Symbol.iterator](): Iterator<T>;
}
interface Iterator<T> {
  next(value?: any): IteratorResult<T>;
}
type IteratorResult<T> = IteratorYieldResult<T> | IteratorReturnResult<any>;
interface IteratorYieldResult<T> {
  done?: false;
  value: T;
}
interface IteratorReturnResult<TReturn> {
  done: true;
  value: TReturn;
}

// ── Standard TypeScript Utility Types ─────────────────────────────────────────
type Partial<T> = { [P in keyof T]?: T[P] };
type Required<T> = { [P in keyof T]-?: T[P] };
type Readonly<T> = { readonly [P in keyof T]: T[P] };
type Pick<T, K extends keyof T> = { [P in K]: T[P] };
type Record<K extends keyof any, T> = { [P in K]: T };
type Exclude<T, U> = T extends U ? never : T;
type Extract<T, U> = T extends U ? T : never;
type Omit<T, K extends keyof any> = Pick<T, Exclude<keyof T, K>>;
type NonNullable<T> = T extends null | undefined ? never : T;
type ReturnType<T extends (...args: any) => any> = T extends (...args: any) => infer R ? R : any;
type InstanceType<T extends abstract new (...args: any) => any> = T extends abstract new (...args: any) => infer R ? R : any;

// ── Standard React & JSX Ambient Types ────────────────────────────────────────
declare var React: any;
declare namespace JSX {
  interface Element {}
  interface IntrinsicElements {
    [elemName: string]: any;
  }
}

// ── Standard Platform Globals ─────────────────────────────────────────────────
declare var console: {
  log(...data: any[]): void;
  info(...data: any[]): void;
  warn(...data: any[]): void;
  error(...data: any[]): void;
  debug(...data: any[]): void;
};

declare var Math: {
  readonly E: number;
  readonly PI: number;
  abs(x: number): number;
  floor(x: number): number;
  ceil(x: number): number;
  round(x: number): number;
  max(...values: number[]): number;
  min(...values: number[]): number;
  random(): number;
};

declare var JSON: {
  parse(text: string): any;
  stringify(value: any, replacer?: any, space?: any): string;
};

declare var setTimeout: (handler: (...args: any[]) => void, timeout?: number, ...args: any[]) => number;
declare var clearTimeout: (handle?: number) => void;
declare var setInterval: (handler: (...args: any[]) => void, timeout?: number, ...args: any[]) => number;
declare var clearInterval: (handle?: number) => void;
declare var performance: { now(): number };
declare var process: any;
declare var window: any;
declare var document: any;
declare var Buffer: any;
`

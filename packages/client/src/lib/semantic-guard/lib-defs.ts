/**
 * packages/client/src/lib/semantic-guard/lib-defs.ts
 *
 * Minimal in-memory standard library declarations (lib.d.ts) for TypeScript compiler API.
 * Provides basic JavaScript core types and globals to eliminate false-positive diagnostics
 * on standard ECMAScript constructs without loading full 40MB Node/DOM typings.
 */

export const MINIMAL_LIB_D_TS = `
interface Array<T> {
  length: number;
  [n: number]: T;
  push(...items: T[]): number;
  pop(): T | undefined;
  map<U>(callbackfn: (value: T, index: number, array: T[]) => U): U[];
  filter(predicate: (value: T, index: number, array: T[]) => unknown): T[];
  forEach(callbackfn: (value: T, index: number, array: T[]) => void): void;
  find(predicate: (value: T, index: number, obj: T[]) => boolean): T | undefined;
  indexOf(searchElement: T, fromIndex?: number): number;
  includes(searchElement: T, fromIndex?: number): boolean;
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
}
interface Object {
  toString(): string;
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
}

interface Promise<T> {
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | Promise<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | Promise<TResult2>) | null
  ): Promise<TResult1 | TResult2>;
  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | Promise<TResult>) | null
  ): Promise<T | TResult>;
}

interface Map<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): this;
  has(key: K): boolean;
  delete(key: K): boolean;
  clear(): void;
  readonly size: number;
  forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void): void;
}

interface Set<T> {
  add(value: T): this;
  has(value: T): boolean;
  delete(value: T): boolean;
  clear(): void;
  readonly size: number;
  forEach(callbackfn: (value: T, value2: T, set: Set<T>) => void): void;
}

type Record<K extends keyof any, T> = {
  [P in K]: T;
};

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
`

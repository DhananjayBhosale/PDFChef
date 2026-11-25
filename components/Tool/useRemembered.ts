import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { useLocation } from 'react-router-dom';
import { readToolSetting, writeToolSetting } from '../../services/toolSettings';

/**
 * A tool setting that starts where the person left it last time (path to 9, item 5). Like
 * `useState`, kept per tool route on this device only; the rules for what may be kept are in
 * `services/toolSettings.ts` (never a password, never anything tied to one file). A kept value
 * that `valid` rejects (another version's range) gives way to `initial`. Only a change the
 * person makes is kept, so an untouched default is never written.
 */
export const useRemembered = <T extends string | number | boolean>(
  name: string,
  initial: T,
  valid?: (value: T) => boolean,
): [T, Dispatch<SetStateAction<T>>] => {
  const { pathname } = useLocation();
  const [value, setValue] = useState<T>(() => {
    const kept = readToolSetting(pathname, name, initial);
    return !valid || valid(kept) ? kept : initial;
  });
  const set = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    setValue((current) => {
      const resolved = typeof next === 'function' ? (next as (previous: T) => T)(current) : next;
      if (resolved !== current) writeToolSetting(pathname, name, resolved);
      return resolved;
    });
  }, [pathname, name]);
  return [value, set];
};

/**
 * Several settings kept together as one object (PDF to Image's format, quality and scale), each
 * field under its own name, by the same rules as `useRemembered`.
 */
export const useRememberedFields = <T extends { [K in keyof T]: string | number | boolean }>(
  initial: T,
  valid?: Partial<{ [K in keyof T]: (value: T[K]) => boolean }>,
): [T, Dispatch<SetStateAction<T>>] => {
  const { pathname } = useLocation();
  const [value, setValue] = useState<T>(() => {
    const kept = { ...initial };
    for (const key of Object.keys(initial) as (keyof T & string)[]) {
      const read = readToolSetting(pathname, key, initial[key]);
      const check = valid?.[key];
      kept[key] = (!check || check(read as T[typeof key]) ? read : initial[key]) as T[typeof key];
    }
    return kept;
  });
  const set = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    setValue((current) => {
      const resolved = typeof next === 'function' ? (next as (previous: T) => T)(current) : next;
      for (const key of Object.keys(resolved) as (keyof T & string)[]) {
        if (resolved[key] !== current[key]) writeToolSetting(pathname, key, resolved[key]);
      }
      return resolved;
    });
  }, [pathname]);
  return [value, set];
};

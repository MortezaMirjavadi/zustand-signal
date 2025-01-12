/// <reference types="react/experimental" />

import ReactExports, {
  createElement as createElementOrig,
  useEffect,
  useReducer,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';

const use =
  ReactExports.use ||
  (<T>(
    promise: Promise<T> & {
      status?: 'pending' | 'fulfilled' | 'rejected';
      value?: T;
      reason?: unknown;
    },
  ): T => {
    if (promise.status === 'pending') {
      throw promise;
    } else if (promise.status === 'fulfilled') {
      return promise.value as T;
    } else if (promise.status === 'rejected') {
      throw promise.reason;
    } else {
      promise.status = 'pending';
      promise.then(
        (v) => {
          promise.status = 'fulfilled';
          promise.value = v;
        },
        (e) => {
          promise.status = 'rejected';
          promise.reason = e;
        },
      );
      throw promise;
    }
  });

type Store = StoreApi<unknown>;

type Unsubscribe = () => void;
type Subscribe = (callback: () => void) => Unsubscribe;
type GetValue = () => unknown;

const SIGNAL = Symbol('ZUSTAND_SIGNAL');
type Signal = {
  [SIGNAL]: { sub: Subscribe; get: GetValue };
};
const isSignal = (x: unknown): x is Signal => !!(x as any)?.[SIGNAL];

const createSignal = (sub: Subscribe, get: GetValue): Signal => {
  const sig = new Proxy(
    (() => {
      // empty
    }) as any,
    {
      get(_target, prop) {
        if (prop === SIGNAL) {
          return { sub, get };
        }
        return createSignal(sub, () => {
          const obj = get() as any;
          if (typeof obj[prop] === 'function') {
            return obj[prop].bind(obj);
          }
          return obj[prop];
        });
      },
      apply(_target, _thisArg, args) {
        return createSignal(sub, () => {
          const fn = get() as any;
          return fn(...args);
        });
      },
    },
  );
  return sig;
};

const storeCache = new WeakMap<
  Store,
  WeakMap<(state: any) => any, WeakMap<(a: any, b: any) => boolean, Signal>>
>();

const getStoreSignal = <T, S>(
  store: StoreApi<T>,
  selector: (state: T) => S,
  equalityFn: (a: S, b: S) => boolean,
): Signal => {
  let cache2 = storeCache.get(store);
  if (!cache2) {
    cache2 = new WeakMap();
    storeCache.set(store, cache2);
  }
  let cache3 = cache2.get(selector);
  if (!cache3) {
    cache3 = new WeakMap();
    cache2.set(selector, cache3);
  }
  let sig = cache3.get(equalityFn);
  if (!sig) {
    let selected = selector(store.getState());
    const sub: Subscribe = (callback) =>
      store.subscribe(() => {
        const nextSelected = selector(store.getState());
        if (!equalityFn(selected, nextSelected)) {
          selected = nextSelected;
          callback();
        }
      });
    const get: GetValue = () => selected;
    sig = createSignal(sub, get);
    cache3.set(equalityFn, sig);
  }
  return sig;
};

const subscribeSignal = (sig: Signal, callback: () => void) => {
  return sig[SIGNAL].sub(callback);
};

const readSignal = (sig: Signal) => {
  const value = sig[SIGNAL].get();
  if (value instanceof Promise) {
    // HACK this could violate the rule of using `use`.
    return use(value);
  }
  return value;
};

const identity = <T>(x: T): T => x;

export function $<T>(store: StoreApi<T>): T;

export function $<T, S>(
  store: StoreApi<T>,
  selector: (state: T) => S,
  equalityFn?: (a: S, b: S) => boolean,
): S;

export function $<T, S>(
  store: StoreApi<T>,
  selector: (state: T) => S = identity as any,
  equalityFn: (a: S, b: S) => boolean = Object.is as any,
) {
  return getStoreSignal(store, selector, equalityFn); // HACK lie type
}

const useMemoList = <T>(list: T[], compareFn = (a: T, b: T) => a === b) => {
  const [state, setState] = useState(list);
  const listChanged =
    list.length !== state.length ||
    list.some((arg, index) => !compareFn(arg, state[index] as T));
  if (listChanged) {
    // schedule update, triggers re-render
    setState(list);
  }
  return listChanged ? list : state;
};

const Rerenderer = ({
  signals,
  render,
}: {
  signals: Signal[];
  render: () => ReactNode;
}): ReactNode => {
  const [, rerender] = useReducer((c) => c + 1, 0);
  const memoedSignals = useMemoList(signals);
  useEffect(() => {
    const unsubs = memoedSignals.map((sig) => subscribeSignal(sig, rerender));
    return () => unsubs.forEach((unsub) => unsub());
  }, [memoedSignals]);
  return render();
};

const findAllSignals = (x: unknown): Signal[] => {
  if (isSignal(x)) {
    return [x];
  }
  if (Array.isArray(x)) {
    return x.flatMap(findAllSignals);
  }
  if (typeof x === 'object' && x !== null) {
    return Object.values(x).flatMap(findAllSignals);
  }
  return [];
};

const fillAllSignalValues = <T>(x: T): T => {
  if (isSignal(x)) {
    return readSignal(x) as T;
  }
  if (Array.isArray(x)) {
    let changed = false;
    const x2 = x.map((item) => {
      const item2 = fillAllSignalValues(item);
      if (item !== item2) {
        changed = true; // HACK side effect
      }
      return item2;
    });
    return changed ? (x2 as typeof x) : x;
  }
  if (typeof x === 'object' && x !== null) {
    let changed = false;
    const x2 = Object.fromEntries(
      Object.entries(x).map(([key, value]) => {
        const value2 = fillAllSignalValues(value);
        if (value !== value2) {
          changed = true; // HACK side effect
        }
        return [key, value2];
      }),
    );
    return changed ? (x2 as typeof x) : x;
  }
  return x;
};

export const createElement = ((type: any, props?: any, ...children: any[]) => {
  const signalsInChildren = children.flatMap((child) =>
    isSignal(child) ? [child] : [],
  );
  const signalsInProps = findAllSignals(props);
  if (!signalsInChildren.length && !signalsInProps.length) {
    return createElementOrig(type, props, ...children);
  }
  const getChildren = () =>
    signalsInChildren.length
      ? children.map((child) => (isSignal(child) ? readSignal(child) : child))
      : children;
  const getProps = () =>
    signalsInProps.length ? fillAllSignalValues(props) : props;
  return createElementOrig(Rerenderer as any, {
    signals: [...signalsInChildren, ...signalsInProps],
    render: () => createElementOrig(type, getProps(), ...getChildren()),
  });
}) as typeof createElementOrig;

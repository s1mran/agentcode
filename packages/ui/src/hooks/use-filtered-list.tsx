import fuzzysort from "fuzzysort"
import { entries, flatMap, groupBy, map, pipe } from "remeda"
import { createEffect, createMemo, createResource, on } from "solid-js"
import { createStore } from "solid-js/store"
import { createList } from "solid-list"

export interface FilteredListProps<T> {
  items: T[] | ((filter: string) => T[] | Promise<T[]>)
  key: (item: T) => string
  filterKeys?: string[]
  current?: T
  groupBy?: (x: T) => string
  sortBy?: (a: T, b: T) => number
  sortGroupsBy?: (a: { category: string; items: T[] }, b: { category: string; items: T[] }) => number
  skipFilter?: (item: T) => boolean
  onSelect?: (value: T | undefined, index: number) => void
  noInitialSelection?: boolean
  /** Whether an item exactly matches the filter; exact matches are listed first and can be run by Enter. */
  exact?: (item: T, filter: string) => boolean
  /**
   * When set, Enter selects only an item the user picked (arrow keys, ctrl-n/p or hover) or an exact match, never the
   * first fuzzy result, and only that item is highlighted. A function is read on every key press.
   */
  requireExplicitEnter?: boolean | (() => boolean)
  /** Called when Enter finds no item to select while `requireExplicitEnter` is set. */
  onEnterUnmatched?: (filter: string) => void
}

/** Moves the items that exactly match the filter to the front, keeping the order within both groups. */
export function pinExactMatches<T>(items: T[], filter: string, exact?: (item: T, filter: string) => boolean): T[] {
  if (!exact || !filter) return items
  const hits: T[] = []
  const rest: T[] = []
  for (const item of items) (exact(item, filter) ? hits : rest).push(item)
  return hits.length > 0 ? [...hits, ...rest] : items
}

/** The item Enter selects: the active one, or with `requireExplicit` only an explicitly picked or exact match. */
export function resolveEnterTarget<T>(input: {
  items: T[]
  key: (item: T) => string
  active: string | null | undefined
  explicit: boolean
  filter: string
  exact?: (item: T, filter: string) => boolean
  requireExplicit?: boolean
}): T | undefined {
  if (!input.requireExplicit || input.explicit) return input.items.find((item) => input.key(item) === input.active)
  const exact = input.exact
  if (!exact) return
  return input.items.find((item) => exact(item, input.filter))
}

/**
 * The key of the item to show as highlighted: the one Enter would select. While Enter needs an explicit pick, a fuzzy
 * first result is not highlighted, so the list never shows a row that Enter would not run.
 */
export function highlightedKey<T>(input: Parameters<typeof resolveEnterTarget<T>>[0]): string | undefined {
  if (!input.requireExplicit || input.explicit) return input.active || undefined
  const target = resolveEnterTarget(input)
  return target === undefined ? undefined : input.key(target)
}

/** The index an arrow key moves to from the highlighted index (-1 when nothing is highlighted), looping at the ends. */
export function startIndex(length: number, direction: 1 | -1, highlighted: number) {
  if (highlighted < 0) return direction === 1 ? 0 : length - 1
  return (highlighted + direction + length) % length
}

export function useFilteredList<T>(props: FilteredListProps<T>) {
  const [store, setStore] = createStore<{ filter: string; explicit: boolean }>({ filter: "", explicit: false })

  type Group = { category: string; items: [T, ...T[]] }
  const empty: Group[] = []

  const [grouped, { refetch }] = createResource(
    () => ({
      filter: store.filter,
      items: typeof props.items === "function" ? props.items(store.filter) : props.items,
    }),
    async ({ filter, items }) => {
      const query = filter ?? ""
      const needle = query.toLowerCase()
      const all = (await Promise.resolve(items)) || []
      const result = pipe(
        all,
        (x) => {
          if (!needle) return x
          const skipFilter = props.skipFilter
          const filterable = skipFilter ? x.filter((item) => !skipFilter(item)) : x
          const skipped = skipFilter ? x.filter(skipFilter) : []
          const filtered =
            !props.filterKeys && Array.isArray(filterable) && filterable.every((e) => typeof e === "string")
              ? (fuzzysort.go(needle, filterable).map((x) => x.target) as T[])
              : fuzzysort.go(needle, filterable, { keys: props.filterKeys! }).map((x) => x.obj)
          return skipped.length ? [...filtered, ...skipped] : filtered
        },
        (x) => pinExactMatches(x, query, props.exact),
        groupBy((x) => (props.groupBy ? props.groupBy(x) : "")),
        entries(),
        map(([k, v]) => ({ category: k, items: props.sortBy ? v.sort(props.sortBy) : v })),
        (groups) => (props.sortGroupsBy ? groups.sort(props.sortGroupsBy) : groups),
      )
      return result
    },
    { initialValue: empty },
  )

  const flat = createMemo(() => {
    return pipe(
      grouped.latest || [],
      flatMap((x) => x.items),
    )
  })

  function initialActive() {
    if (props.noInitialSelection) return ""
    if (props.current) return props.key(props.current)

    const items = flat()
    if (items.length === 0) return ""
    return props.key(items[0])
  }

  const list = createList({
    items: () => flat().map(props.key),
    initialActive: initialActive(),
    loop: true,
  })

  const reset = () => {
    setStore("explicit", false)
    if (props.noInitialSelection) {
      list.setActive("")
      return
    }
    const all = flat()
    if (all.length === 0) return
    list.setActive(props.key(all[0]))
  }

  const requireExplicit = () =>
    typeof props.requireExplicitEnter === "function" ? props.requireExplicitEnter() : !!props.requireExplicitEnter

  const enterInput = () => ({
    items: flat(),
    key: props.key,
    active: list.active(),
    explicit: store.explicit,
    filter: store.filter,
    exact: props.exact,
    requireExplicit: requireExplicit(),
  })

  const highlighted = () => highlightedKey(enterInput())

  // While Enter needs an explicit pick, arrows move from the highlighted row, so the first press lands on the first
  // (or last) row the user can see instead of skipping the unhighlighted fuzzy result.
  const navigate = (event: KeyboardEvent, direction: 1 | -1) => {
    setStore("explicit", true)
    if (!requireExplicit()) return list.onKeyDown(event)
    const items = flat()
    if (items.length === 0) return
    const current = highlighted()
    const index = current === undefined ? -1 : items.findIndex((item) => props.key(item) === current)
    list.setActive(props.key(items[startIndex(items.length, direction, index)]))
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault()
      const input = enterInput()
      const target = resolveEnterTarget(input)
      if (target) {
        props.onSelect?.(target, input.items.indexOf(target))
        return
      }
      if (input.requireExplicit) props.onEnterUnmatched?.(store.filter)
    } else if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (event.key === "n" || event.key === "p") {
        event.preventDefault()
        const navEvent = new KeyboardEvent("keydown", {
          key: event.key === "n" ? "ArrowDown" : "ArrowUp",
          bubbles: true,
        })
        navigate(navEvent, event.key === "n" ? 1 : -1)
      }
    } else {
      // Skip list navigation for text editing shortcuts (e.g., Option+Arrow, Option+Backspace on macOS)
      if (event.altKey || event.metaKey) return
      if (event.key === "ArrowUp" || event.key === "ArrowDown")
        return navigate(event, event.key === "ArrowDown" ? 1 : -1)
      list.onKeyDown(event)
    }
  }

  createEffect(
    on(grouped, () => {
      reset()
    }),
  )

  const onInput = (value: string) => {
    setStore({ filter: value, explicit: false })
  }

  // Pointer hover is an explicit choice, so Enter may run the hovered item.
  const setActive = (...args: Parameters<typeof list.setActive>) => {
    setStore("explicit", true)
    list.setActive(...args)
  }

  return {
    grouped,
    filter: () => store.filter,
    flat,
    reset,
    refetch,
    clear: () => setStore({ filter: "", explicit: false }),
    onKeyDown,
    onInput,
    active: list.active,
    /** The key to render as highlighted; differs from `active` only while Enter needs an explicit pick. */
    highlighted,
    setActive,
    explicit: () => store.explicit,
  }
}

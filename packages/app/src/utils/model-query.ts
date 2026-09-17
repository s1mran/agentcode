type PickableModel = {
  id: string
  name: string
  provider: { id: string; name: string }
  latest?: boolean
}

const normalize = (value: string) => value.toLowerCase().replace(/[\s\-_.]+/g, "")

/**
 * A model's id and name, plus the id after a provider prefix (`moonshotai/kimi-k2` → `kimi-k2`) and the name after a
 * vendor label (`MoonshotAI: Kimi K2` → `Kimi K2`).
 */
const shortForms = (model: PickableModel) => [
  model.id,
  model.id.slice(model.id.lastIndexOf("/") + 1),
  model.name,
  model.name.slice(model.name.lastIndexOf(":") + 1),
]

/**
 * Picks the model a `/model <query>` means. An exact `provider/id` wins outright. Otherwise the match tiers, best
 * first, are: an exact id or name; an id or name that starts with the query (ids and names count without a provider
 * prefix or vendor label); every word of the query found in the provider name, name or id. Visible models are
 * searched first and hidden ones only when no visible model matches, so a hidden model never beats one the user keeps
 * in the picker. Within the best tier the recently used, latest and highest-versioned model wins. `others` counts the
 * rest of that tier.
 */
export function pickModel<M extends PickableModel>(
  query: string,
  input: { models: M[]; recent: M[]; visible: (model: M) => boolean },
): { model?: M; others: number } {
  const needle = normalize(query)
  const tokens = query.split(/\s+/).map(normalize).filter(Boolean)
  if (!needle) return { others: 0 }

  const tiers: ((model: M) => boolean)[] = [
    (model) => shortForms(model).some((form) => normalize(form) === needle),
    (model) => shortForms(model).some((form) => normalize(form).startsWith(needle)),
    (model) => {
      const haystack = normalize(`${model.provider.name} ${model.name} ${model.id}`)
      return tokens.length > 0 && tokens.every((token) => haystack.includes(token))
    },
  ]

  const recentIndex = (model: M) => {
    const index = input.recent.findIndex((item) => item.id === model.id && item.provider.id === model.provider.id)
    return index < 0 ? Infinity : index
  }
  const best = (matches: M[]) => {
    const sorted = [...matches].sort((a, b) => {
      const recent = recentIndex(a) - recentIndex(b)
      if (recent !== 0 && !Number.isNaN(recent)) return recent
      const latest = Number(!!b.latest) - Number(!!a.latest)
      if (latest !== 0) return latest
      return b.name.localeCompare(a.name, undefined, { numeric: true })
    })
    return { model: sorted[0], others: sorted.length - 1 }
  }

  const qualified = input.models.filter((model) => normalize(`${model.provider.id}/${model.id}`) === needle)
  if (qualified.length > 0) return best(qualified)

  const visible = input.models.filter((model) => input.visible(model))
  for (const pool of [visible, input.models]) {
    const tier = tiers.map((match) => pool.filter(match)).find((matches) => matches.length > 0)
    if (tier) return best(tier)
  }
  return { others: 0 }
}

import { useEffect, useMemo, useState } from 'react'

interface SpuSkcPair { spu: string; skc: string }

interface UseSpuSkcPickerArgs {
  spuOptions: string[]
  skcOptions: string[]
  pairs: SpuSkcPair[]
}

interface UseSpuSkcPickerResult {
  pendingSpus: string[]
  pendingSkcs: string[]
  selectedSpus: string[]
  selectedSkcs: string[]
  spuKeyword: string
  skcKeyword: string
  filteredSpuOptions: string[]
  filteredSkcOptions: string[]
  setSpuKeyword: (v: string) => void
  setSkcKeyword: (v: string) => void
  toggleSpuPending: (spu: string, checked: boolean) => void
  toggleSkcPending: (skc: string, checked: boolean) => void
  applyPending: () => void
  clearAll: () => void
}

export function useSpuSkcPicker({
  spuOptions, skcOptions,
}: UseSpuSkcPickerArgs): UseSpuSkcPickerResult {
  const [pendingSpus, setPendingSpus] = useState<string[]>([])
  const [pendingSkcs, setPendingSkcs] = useState<string[]>([])
  const [selectedSpus, setSelectedSpus] = useState<string[]>([])
  const [selectedSkcs, setSelectedSkcs] = useState<string[]>([])
  const [spuKeyword, setSpuKeyword] = useState('')
  const [skcKeyword, setSkcKeyword] = useState('')

  const filteredSpuOptions = useMemo(
    () => spuOptions.filter((o) => o.toLowerCase().includes(spuKeyword.trim().toLowerCase())),
    [spuOptions, spuKeyword],
  )
  const filteredSkcOptions = useMemo(
    () => skcOptions.filter((o) => o.toLowerCase().includes(skcKeyword.trim().toLowerCase())),
    [skcOptions, skcKeyword],
  )

  useEffect(() => {
    setPendingSpus((prev) => prev.filter((s) => spuOptions.includes(s)))
    setSelectedSpus((prev) => prev.filter((s) => spuOptions.includes(s)))
  }, [spuOptions])
  useEffect(() => {
    setPendingSkcs((prev) => prev.filter((s) => skcOptions.includes(s)))
    setSelectedSkcs((prev) => prev.filter((s) => skcOptions.includes(s)))
  }, [skcOptions])

  function toggleSpuPending(spu: string, checked: boolean) {
    setPendingSpus((prevSpus) => {
      return checked
        ? [...new Set([...prevSpus, spu])]
        : prevSpus.filter((v) => v !== spu)
    })
  }

  function toggleSkcPending(skc: string, checked: boolean) {
    setPendingSkcs((prevSkcs) => {
      return checked
        ? [...new Set([...prevSkcs, skc])]
        : prevSkcs.filter((v) => v !== skc)
    })
  }

  function applyPending() {
    setSelectedSpus(pendingSpus)
    setSelectedSkcs(pendingSkcs)
  }

  function clearAll() {
    setPendingSpus([])
    setPendingSkcs([])
    setSelectedSpus([])
    setSelectedSkcs([])
  }

  return {
    pendingSpus, pendingSkcs, selectedSpus, selectedSkcs,
    spuKeyword, skcKeyword, filteredSpuOptions, filteredSkcOptions,
    setSpuKeyword, setSkcKeyword,
    toggleSpuPending, toggleSkcPending,
    applyPending, clearAll,
  }
}

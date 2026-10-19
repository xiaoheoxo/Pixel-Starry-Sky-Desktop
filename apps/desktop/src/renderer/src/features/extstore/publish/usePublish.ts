import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExtStoreCheckReport, ExtStorePickUploadResult, ExtStorePublisherState } from '@pixelsky/protocol'
import { parseCodedError } from '@pixelsky/protocol'
import { demo, isDemo } from '@/data/demo'
import { translateMessage } from '@/i18n/core'
import { extstoreBridge } from '../bridge'

// 「我的发布」页的数据：publisher() 结果、选包、上传。PublishTab 本身不读单例，由 PublishPage 把这里的结果当 props 传下去。

export const CHECK_FAILED_KEY = 'extstore.api.checkFailed'

/** 上传失败的错误是不是云端的 check_failed（IPC 只传 message，代码编码在里面） */
export function isCheckFailed(message: string | null | undefined): boolean {
  const text = message ?? ''
  return parseCodedError(text)?.code === CHECK_FAILED_KEY || text.includes(CHECK_FAILED_KEY)
}

const errorText = (e: unknown): string => translateMessage((e as Error)?.message ?? String(e))

function api() {
  return isDemo ? demo().extStore.bridge : extstoreBridge()
}

export interface PublishData {
  state: ExtStorePublisherState | null
  loadError: string | null
  refresh(): void
  register(name: string): Promise<unknown>
  withdraw(id: string, version: string): Promise<unknown>
  delist(id: string): Promise<unknown>
  relist(id: string): Promise<unknown>
  loadReport(id: string, version: string): Promise<ExtStoreCheckReport | null>
  picked: ExtStorePickUploadResult | null
  uploading: boolean
  uploadError: string | null
  cloudReport: ExtStoreCheckReport | null
  pick(input: null | { bytes: ArrayBuffer; name: string }): void
  submit(token: string): void
  cancel(): void
}

const missing = (): Promise<never> => Promise.reject(new Error('extstore unavailable'))

export function usePublish(active: boolean): PublishData {
  const [state, setState] = useState<ExtStorePublisherState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [picked, setPicked] = useState<ExtStorePickUploadResult | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [cloudReport, setCloudReport] = useState<ExtStoreCheckReport | null>(null)
  const alive = useRef(true)
  const seq = useRef(0)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const refresh = useCallback(() => {
    const b = api()
    if (!b) return
    const mine = ++seq.current
    b.publisher()
      .then(s => {
        if (!alive.current || mine !== seq.current) return
        setState(s)
        setLoadError(null)
      })
      .catch(e => {
        if (alive.current && mine === seq.current) setLoadError(errorText(e))
      })
  }, [])

  useEffect(() => {
    if (active) refresh()
    else setState(null)
  }, [active, refresh])

  const b = api()
  return {
    state,
    loadError,
    refresh,
    register: name => b?.register(name) ?? missing(),
    withdraw: (id, v) => b?.withdraw(id, v) ?? missing(),
    delist: id => b?.delist(id) ?? missing(),
    relist: id => b?.relist(id) ?? missing(),
    loadReport: (id, v) => b?.publishCheck(id, v) ?? Promise.resolve(null),
    picked,
    uploading,
    uploadError,
    cloudReport,
    pick: input => {
      const bridge = api()
      if (!bridge) return
      setUploadError(null)
      setCloudReport(null)
      bridge
        .pickUpload(input)
        .then(r => {
          // 取消选择框（null）不清掉已选的
          if (alive.current && r) setPicked(r)
        })
        .catch(e => alive.current && setUploadError(errorText(e)))
    },
    submit: token => {
      const bridge = api()
      // token 为空串：灰掉，不提交
      if (!bridge || !token || uploading || !picked) return
      const { id, version } = picked
      setUploading(true)
      setUploadError(null)
      setCloudReport(null)
      bridge
        .upload(token)
        .then(() => {
          if (!alive.current) return
          setPicked(null)
          refresh()
        })
        .catch(async e => {
          const message = (e as Error)?.message ?? String(e)
          let report: ExtStoreCheckReport | null = null
          if (isCheckFailed(message)) report = await bridge.publishCheck(id, version).catch(() => null)
          if (!alive.current) return
          setUploadError(errorText(e))
          setCloudReport(report)
        })
        .finally(() => alive.current && setUploading(false))
    },
    cancel: () => {
      setPicked(null)
      setUploadError(null)
      setCloudReport(null)
    },
  }
}

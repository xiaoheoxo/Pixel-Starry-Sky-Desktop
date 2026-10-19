import { useAccount } from '@/features/account'
import { PublishTab } from './PublishTab'
import { usePublish } from './usePublish'

/** 扩展页「我的发布」页签的容器：账号状态 + usePublish 的数据接给 PublishTab */
export function PublishPage() {
  const account = useAccount()
  const signedIn = account.status === 'signed-in'
  const data = usePublish(signedIn)
  return (
    <PublishTab
      signedIn={signedIn}
      email={account.user?.email ?? null}
      state={data.state}
      loadError={data.loadError}
      onSignIn={() => void account.login()}
      onRefresh={data.refresh}
      onRegister={data.register}
      onWithdraw={data.withdraw}
      onDelist={data.delist}
      onRelist={data.relist}
      onLoadReport={data.loadReport}
      picked={data.picked}
      uploading={data.uploading}
      uploadError={data.uploadError}
      cloudReport={data.cloudReport}
      onPick={data.pick}
      onSubmitUpload={data.submit}
      onCancelUpload={data.cancel}
    />
  )
}

import { ResumePicker } from './ResumePicker'
import { useResumeRequest } from './store'

/** 每个窗口只有一个选择框：输入框、命令面板都往 store 里放请求，这里接住显示（App 根上挂一次） */
export function ResumeHost() {
  const request = useResumeRequest()
  return request ? <ResumePicker key={request.key} request={request} /> : null
}
